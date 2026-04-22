import { app, BrowserWindow, session, shell, systemPreferences } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc';
import {
  registerProjectFileProtocol,
  registerProjectFileSchemeAsPrivileged,
} from './editor/protocol';
import { startCompanionServer, stopCompanionServer } from './companion/server';

// Must run before app ready.
registerProjectFileSchemeAsPrivileged();

// Final safety net: anything that somehow escapes a try/catch or an event
// handler lands here. Without this, Electron shows a crash dialog at
// startup and the app never becomes usable — e.g. a post-bind socket
// error on the companion server, or a transient DNS hiccup during the
// public-cert fetch. We log and keep the event loop alive; individual
// subsystems are responsible for their own recovery.
process.on('uncaughtException', (err) => {
  console.warn('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.warn('[unhandledRejection]', reason);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// process.env.DIST is set by vite-plugin-electron to the dist-electron folder.
process.env.APP_ROOT = path.join(__dirname, '..');
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0a0a0b',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open target=_blank links in the user's default browser, not a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }
}

// macOS TCC: prompt the user for camera & microphone on first launch of a
// packaged build. Without these calls getUserMedia can resolve with a black
// track (devices enumerate, but no live frames) — because nothing ever
// triggered the system permission prompt.
async function requestMediaAccess() {
  if (process.platform !== 'darwin') return;
  try {
    await systemPreferences.askForMediaAccess('camera');
    await systemPreferences.askForMediaAccess('microphone');
  } catch (e) {
    console.warn('askForMediaAccess failed:', e);
  }
}

// Grant the renderer's getUserMedia / getDisplayMedia requests. Electron's
// default handler denies them in packaged builds unless we opt in.
function wireMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      if (
        permission === 'media' ||
        permission === 'mediaKeySystem' ||
        permission === 'display-capture'
      ) {
        return callback(true);
      }
      callback(false);
    },
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media' || permission === 'mediaKeySystem';
  });
}

app.whenReady().then(async () => {
  registerProjectFileProtocol();
  registerIpc();
  wireMediaPermissions();
  await requestMediaAccess();
  createWindow();
  // Boot the companion HTTPS server eagerly so the URL is live from the
  // moment the app is running. Previously this only happened when the
  // user clicked "Add phone" — meaning phones that tried to connect
  // before that step got a white screen / "search or enter URL" on iOS.
  startCompanionServer().catch((e) =>
    console.warn('companion server failed to start:', e),
  );
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
  mainWindow = null;
});

app.on('before-quit', async () => {
  try {
    await stopCompanionServer();
  } catch {
    // ignore
  }
});

// Start the companion server lazily, on demand, via IPC — keeps startup
// fast and avoids binding a port when the user never opens a phone.
export { startCompanionServer };

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
