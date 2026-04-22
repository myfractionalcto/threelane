import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { app as electronApp } from 'electron';
import forge from 'node-forge';
import { getOrCreateCert, buildMobileConfig, pickLanIp } from './cert';
import { getPublicCert, hostnameForIp } from './public-cert';
import { devices } from './state';

/**
 * HTTPS + WebSocket server that serves the mobile PWA and coordinates
 * recording with phones on the same WiFi.
 *
 * Routes:
 *   GET /                  → mobile-pwa/index.html
 *   GET /manifest.webmanifest, /app.js, /style.css, /icon-*.png
 *   POST /upload/:projectId/:deviceId  → writes `mobile-<deviceId>.webm`
 *   WS  /ws                → command/event channel (JSON frames)
 *
 * Start once per app launch. The server is long-lived; sessions (projects)
 * come and go without restarting it.
 */

export interface ServerInfo {
  /** Primary URL we hand to phones. Uses the public-cert hostname when
   *  available (no install needed), otherwise falls back to the raw-IP URL. */
  url: string;
  /** Raw-IP URL always present as an explicit fallback. Requires the local
   *  CA to be installed on the phone. Surfaced to the PWA so it can retry
   *  against this if DNS resolution of the hostname fails. */
  urlFallback: string;
  /** Hostname component of `url` (no scheme/port), e.g. `192-168-1-23.local-ip.sh`.
   *  `null` if no public cert is active and we're serving the raw-IP URL. */
  hostname: string | null;
  port: number;
  ip: string;
  cert: string; // Local CA leaf PEM — exposed to the renderer for the "install on phone" flow.
  /** Plain-HTTP URL for CA install. HTTPS is chicken-and-egg before the
   *  phone trusts the CA, so the bootstrap routes live on a second port. */
  certInstallUrl: string;
  /** True if we successfully loaded the public (`*.local-ip.sh`) cert and
   *  the primary URL is the hostname form. False means we couldn't reach
   *  the service and the UI should nudge users toward the CA install flow. */
  publicCertActive: boolean;
}

/**
 * Fixed listener port so an installed PWA's URL stays valid across Electron
 * restarts. Random port meant the phone's saved PWA URL would break every
 * relaunch — not acceptable UX. If this port is already taken, we fall back
 * to a random one and print a warning (PWA will need to re-target).
 */
const PREFERRED_PORT = 47878;
/**
 * Separate HTTP port for CA downloads. Kept adjacent to the HTTPS port so
 * it's easy to remember. Plain HTTP is deliberate — iOS Safari won't install
 * a .mobileconfig from a site whose cert isn't already trusted, which would
 * require the phone to first trust the very CA it's trying to download.
 */
const PREFERRED_CERT_PORT = 47879;

let serverInfo: ServerInfo | null = null;
let httpsServer: https.Server | null = null;
let certHttpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
/**
 * Single-flight guard. Multiple callers (main.ts on app-ready + the renderer's
 * `companion:start` IPC when the panel mounts) race to boot the server;
 * without this they'd both create HTTPS servers and the second would throw
 * EADDRINUSE. Everyone now awaits the same promise.
 */
let bootPromise: Promise<ServerInfo> | null = null;
/** Set whenever a recording is armed — incoming uploads go into this project. */
let currentProjectId: string | null = null;
/** Resolved per-device when the phone uploads its file and signals done. */
const uploadWaiters = new Map<string, (file: string) => void>();
/** Uploads that arrived before anyone was waiting — claimed by the next
 *  `waitForDeviceUploads` call so no upload is ever lost to a race. */
const pendingCompletedUploads = new Map<string, string>();

/**
 * Return the packaged mobile-pwa directory. In dev we read straight from
 * the source tree; in a bundled app we read from `Resources/mobile-pwa/`
 * (electron-builder extraResources) — we'll wire that up later when
 * packaging; for now, dev-tree fallback covers both.
 */
function mobilePwaDir(): string {
  // Dev: __dirname inside dist-electron/ → repo root/dist-electron; source
  // sits at repo root/mobile-pwa.
  // Packaged: electron-builder copies mobile-pwa/ into app.asar and we ask
  // asarUnpack to keep it on disk so express can serve raw files.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', 'mobile-pwa'),
    path.resolve(here.replace('app.asar', 'app.asar.unpacked'), '..', 'mobile-pwa'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      // next
    }
  }
  return candidates[0];
}

function projectDir(projectId: string): string {
  return path.join(electronApp.getPath('home'), 'Movies', 'Threelane', projectId);
}

export function setCurrentProject(projectId: string | null) {
  currentProjectId = projectId;
}

/**
 * Wait for every connected device to finish uploading. Resolves to a list
 * of `{deviceId, file, mimeType, durationMs}` entries. Times out after a
 * generous window to avoid hanging the UI forever.
 */
export async function waitForDeviceUploads(
  deviceIds: string[],
  timeoutMs = 60_000,
): Promise<{ id: string; file: string }[]> {
  if (deviceIds.length === 0) return [];
  return new Promise((resolve) => {
    const result: { id: string; file: string }[] = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      for (const id of deviceIds) uploadWaiters.delete(id);
      done();
    }, timeoutMs);
    // Claim any uploads that already arrived before we got here.
    const pendingIds: string[] = [];
    for (const id of deviceIds) {
      const early = pendingCompletedUploads.get(id);
      if (early) {
        pendingCompletedUploads.delete(id);
        result.push({ id, file: early });
      } else {
        pendingIds.push(id);
      }
    }
    if (pendingIds.length === 0) {
      clearTimeout(timer);
      done();
      return;
    }
    for (const id of pendingIds) {
      uploadWaiters.set(id, (file) => {
        result.push({ id, file });
        if (result.length === deviceIds.length) {
          clearTimeout(timer);
          done();
        }
      });
    }
  });
}

export function broadcastStart(startAtMs: number, projectId: string) {
  devices.broadcast({ type: 'start', startAtMs, projectId });
}

export function broadcastStop() {
  devices.broadcast({ type: 'stop' });
}

export async function startCompanionServer(): Promise<ServerInfo> {
  if (serverInfo) return serverInfo;
  if (bootPromise) return bootPromise;
  bootPromise = bootCompanionServer().finally(() => {
    // Clear the guard on both success and failure. On success serverInfo
    // short-circuits future calls; on failure we want the next caller to
    // retry from scratch rather than get a stale rejection.
    bootPromise = null;
  });
  return bootPromise;
}

async function bootCompanionServer(): Promise<ServerInfo> {
  const cert = await getOrCreateCert();
  const expressApp = express();
  const pwaDir = mobilePwaDir();

  // CORS — the PWA may send requests from a different origin after the
  // user scans a QR pointing at a new URL. Keeping this permissive for
  // now; phones on the LAN are the only reachable clients anyway.
  expressApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Duration-Ms',
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ── CA certificate download routes ────────────────────────────────
  // Also registered on the HTTPS app as a convenience (if the phone
  // already trusted a previous CA, this works from inside the PWA too),
  // but the canonical URL we hand out is the HTTP one — iOS Safari will
  // not install .mobileconfig from an untrusted HTTPS origin, and an
  // untrusted origin is exactly what we have before the CA is installed.
  attachCaRoutes(expressApp, cert.ca);

  // Vendor pass-through: serve jsQR from node_modules so the mobile PWA
  // can decode QR codes without a separate bundle step.
  expressApp.get('/vendor/jsqr.js', (_req, res) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // In dev: here = repo root / dist-electron. node_modules is one up.
    const jsqrPath = path.resolve(
      here,
      '..',
      'node_modules',
      'jsqr',
      'dist',
      'jsQR.js',
    );
    res.sendFile(jsqrPath, (err) => {
      if (err) res.status(404).send('jsqr not found');
    });
  });

  // Static PWA files.
  expressApp.use(express.static(pwaDir, { extensions: ['html'] }));

  // Streaming upload endpoint. Using `req.pipe` keeps memory flat even for
  // long recordings — the whole file never sits in Node's heap.
  expressApp.post('/upload/:projectId/:deviceId', async (req, res) => {
    const { projectId, deviceId } = req.params;
    const contentType = req.headers['content-type'] ?? 'application/octet-stream';
    const durationHeader = req.headers['x-duration-ms'];
    const durationMs =
      typeof durationHeader === 'string' ? parseInt(durationHeader, 10) : 0;
    const total = parseInt(req.headers['content-length'] ?? '0', 10) || undefined;
    const ext = contentType.includes('mp4') ? 'mp4' : 'webm';
    const dir = projectDir(projectId);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      // ignore
    }
    const filename = `mobile-${deviceId}.${ext}`;
    const full = path.join(dir, filename);
    devices.setPhase(deviceId, 'uploading');

    const write = fs.createWriteStream(full);
    let got = 0;
    req.on('data', (chunk: Buffer) => {
      got += chunk.byteLength;
      devices.setUploadProgress(deviceId, got, total);
    });
    req.on('error', (e) => {
      write.destroy(e);
      res.status(500).send('upload error');
    });
    req.pipe(write);
    write.on('finish', () => {
      devices.setUploaded(deviceId, filename, durationMs, contentType);
      const waiter = uploadWaiters.get(deviceId);
      if (waiter) {
        waiter(filename);
        uploadWaiters.delete(deviceId);
      } else {
        // Nobody's listening yet — stash so the next waitForDeviceUploads
        // call can claim it. Prevents lost uploads when the phone finishes
        // before the laptop gets to the wait step.
        pendingCompletedUploads.set(deviceId, filename);
      }
      res.json({ ok: true, file: filename });
    });
    write.on('error', (e) => {
      res.status(500).send(`write error: ${e.message}`);
    });
  });

  // Last-resort handler so the static middleware's 404 doesn't get HTML
  // when the phone probes weird paths.
  expressApp.use((_req, res) => {
    res.status(404).send('not found');
  });

  // Build TLS contexts. The phone connects to one of two hostnames:
  //   - `<ip-dashes>.local-ip.sh` → serve the public LE wildcard (no install
  //     needed, just works). This is the default path we advertise.
  //   - raw IP (no SNI, or SNI === the IP literal) → serve our local CA
  //     leaf. Fallback for networks with DNS-rebinding protection.
  // `SNICallback` picks per-connection; `cert`/`key` at the top level is
  // the default for TLS clients that don't send SNI (raw-IP connections).
  const publicCert = await getPublicCert();
  const localCtx = tls.createSecureContext({
    cert: cert.cert + cert.ca,
    key: cert.key,
    ca: cert.ca,
  });
  const publicCtx = publicCert
    ? tls.createSecureContext({ cert: publicCert.cert, key: publicCert.key })
    : null;

  httpsServer = https.createServer(
    {
      cert: cert.cert + cert.ca,
      key: cert.key,
      ca: cert.ca,
      SNICallback: (servername, cb) => {
        if (publicCtx && servername && servername.endsWith('.local-ip.sh')) {
          cb(null, publicCtx);
        } else {
          cb(null, localCtx);
        }
      },
    },
    expressApp,
  );
  // Safety-net: post-bind errors (TLS hiccups, socket resets during shutdown,
  // late EADDRINUSE from a racing caller) would otherwise bubble up as an
  // Uncaught Exception and crash the app. Log and drop.
  httpsServer.on('error', (err) => {
    console.warn('companion HTTPS server error:', err);
  });
  wss = new WebSocketServer({ server: httpsServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    const ua = String(req.headers['user-agent'] ?? '');
    const id = cryptoRandomId();
    devices.add(id, ws, deviceLabel(ua), ua);
    // Tell the device its assigned id — it'll use it in the upload URL.
    try {
      ws.send(JSON.stringify({ type: 'hello', id }));
    } catch {}

    ws.on('message', (raw) => handleWsMessage(id, ws, raw.toString()));
    ws.on('close', () => devices.remove(id));
    ws.on('error', () => devices.remove(id));
  });

  // Bind on the LAN IP only (not 0.0.0.0) so we aren't advertising on
  // every interface — reduces spurious connections from unrelated
  // networks. Prefer the fixed port first; if it's taken, fall back to
  // a random one and warn (installed PWAs may need to re-scan the QR).
  await new Promise<void>((resolve, reject) => {
    const tryPort = (port: number, retriedRandom: boolean) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (!retriedRandom && err.code === 'EADDRINUSE') {
          console.warn(
            `Companion: port ${PREFERRED_PORT} in use; falling back to random. Installed PWAs may need a QR re-scan.`,
          );
          httpsServer!.removeListener('error', onError);
          tryPort(0, true);
          return;
        }
        reject(err);
      };
      httpsServer!.once('error', onError);
      httpsServer!.listen(port, cert.ip, () => {
        httpsServer!.removeListener('error', onError);
        const addr = httpsServer!.address();
        if (addr && typeof addr === 'object') {
          const hostname = publicCert ? hostnameForIp(cert.ip) : null;
          const urlFallback = `https://${cert.ip}:${addr.port}`;
          const urlPrimary = hostname
            ? `https://${hostname}:${addr.port}`
            : urlFallback;
          serverInfo = {
            url: urlPrimary,
            urlFallback,
            hostname,
            port: addr.port,
            ip: cert.ip,
            cert: cert.cert,
            certInstallUrl: '', // filled in after HTTP listener comes up
            publicCertActive: publicCert !== null,
          };
        }
        resolve();
      });
    };
    tryPort(PREFERRED_PORT, false);
  });

  // ── Plain-HTTP listener for CA bootstrap ──────────────────────────
  // Separate app/server so the routes here *can't* accidentally end up
  // being served over HTTPS too, and so CORS/middleware from the main
  // app can't break them.
  const certApp = express();
  certApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  // A tiny landing page so visiting the bare URL in a browser actually
  // shows what to do instead of a 404.
  certApp.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(caLandingHtml(cert.ip));
  });
  attachCaRoutes(certApp, cert.ca);
  certApp.use((_req, res) => res.status(404).send('not found'));
  certHttpServer = http.createServer(certApp);
  certHttpServer.on('error', (err) => {
    console.warn('companion HTTP cert server error:', err);
  });

  await new Promise<void>((resolve, reject) => {
    const tryPort = (port: number, retriedRandom: boolean) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (!retriedRandom && err.code === 'EADDRINUSE') {
          console.warn(
            `Companion: HTTP cert port ${PREFERRED_CERT_PORT} in use; falling back to random.`,
          );
          certHttpServer!.removeListener('error', onError);
          tryPort(0, true);
          return;
        }
        reject(err);
      };
      certHttpServer!.once('error', onError);
      certHttpServer!.listen(port, cert.ip, () => {
        certHttpServer!.removeListener('error', onError);
        const addr = certHttpServer!.address();
        if (addr && typeof addr === 'object' && serverInfo) {
          serverInfo.certInstallUrl = `http://${cert.ip}:${addr.port}`;
        }
        resolve();
      });
    };
    tryPort(PREFERRED_CERT_PORT, false);
  });

  return serverInfo!;
}

/**
 * Register the three CA-download routes on a given express app. Shared by
 * the main HTTPS app (as a convenience) and the HTTP bootstrap app (the
 * canonical entry point surfaced to users).
 */
function attachCaRoutes(app: express.Express, caPem: string) {
  // Raw PEM — works on Android ("Install from storage" in Settings).
  app.get('/ca.pem', (_req, res) => {
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="ThreelaneCA.pem"');
    res.send(caPem);
  });

  // DER-encoded .crt — Android can install directly from download.
  app.get('/ca.crt', (_req, res) => {
    const caCert = forge.pki.certificateFromPem(caPem);
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(caCert)).getBytes();
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="ThreelaneCA.crt"');
    res.send(Buffer.from(der, 'binary'));
  });

  // iOS .mobileconfig profile — tap to install in Settings.
  app.get('/ca.mobileconfig', (_req, res) => {
    const xml = buildMobileConfig(caPem);
    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.setHeader('Content-Disposition', 'attachment; filename="Threelane.mobileconfig"');
    res.send(xml);
  });
}

function caLandingHtml(ip: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Threelane · Install CA</title>
<style>
  body { font: 16px/1.4 -apple-system, system-ui, sans-serif; max-width: 520px; margin: 32px auto; padding: 0 20px; color: #111; }
  h1 { font-size: 20px; }
  a.btn { display: block; padding: 14px 16px; margin: 10px 0; border-radius: 12px; background: #111; color: #fff; text-decoration: none; text-align: center; font-weight: 600; }
  a.btn.alt { background: #f2f2f2; color: #111; }
  .hint { color: #666; font-size: 13px; margin-top: 8px; }
  code { background: #f2f2f2; padding: 2px 5px; border-radius: 4px; font-size: 13px; }
  ol { padding-left: 20px; }
</style>
</head><body>
<h1>Install Threelane Local CA</h1>
<p>Your phone needs to trust the laptop's HTTPS certificate before the companion camera will work.</p>
<a class="btn" href="/ca.mobileconfig">iPhone / iPad — download profile</a>
<a class="btn alt" href="/ca.crt">Android — download .crt</a>
<p class="hint">After downloading on iPhone:</p>
<ol>
  <li>Open <b>Settings</b> → the new "Profile Downloaded" banner near the top.</li>
  <li>Tap it → <b>Install</b> (top right) → enter passcode → <b>Install</b> again.</li>
  <li>Go to <b>Settings → General → About → Certificate Trust Settings</b>.</li>
  <li>Toggle on <b>Threelane Local CA</b>.</li>
</ol>
<p class="hint">Then open <code>https://${ip}:${PREFERRED_PORT}</code> — no more warning.</p>
</body></html>`;
}

export async function stopCompanionServer(): Promise<void> {
  if (wss) {
    wss.close();
    wss = null;
  }
  if (httpsServer) {
    await new Promise<void>((resolve) => httpsServer!.close(() => resolve()));
    httpsServer = null;
  }
  if (certHttpServer) {
    await new Promise<void>((resolve) => certHttpServer!.close(() => resolve()));
    certHttpServer = null;
  }
  serverInfo = null;
}

export function getServerInfo(): ServerInfo | null {
  return serverInfo;
}

function deviceLabel(ua: string): string {
  if (/iPhone|iPad/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android phone';
  return 'Mobile device';
}

function cryptoRandomId(): string {
  // 8 chars base36 is plenty for per-session uniqueness.
  return Math.random().toString(36).slice(2, 10);
}

function handleWsMessage(id: string, ws: WebSocket, raw: string) {
  let msg: { type?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'ready': {
      devices.setPhase(id, 'ready');
      break;
    }
    case 'recording-started': {
      devices.setPhase(id, 'recording');
      break;
    }
    case 'ping': {
      // Phone asks "what time is it?" — we answer with our wall-clock.
      // Phone computes offset locally using the round-trip midpoint.
      type PingMsg = { type: 'ping'; clientTime: number };
      const ping = msg as PingMsg;
      try {
        ws.send(
          JSON.stringify({
            type: 'pong',
            clientTime: ping.clientTime,
            serverTime: Date.now(),
          }),
        );
      } catch {
        // socket closed
      }
      break;
    }
    case 'offset': {
      type OffsetMsg = { type: 'offset'; clockOffsetMs: number };
      const m = msg as OffsetMsg;
      if (typeof m.clockOffsetMs === 'number') {
        devices.setOffset(id, m.clockOffsetMs);
      }
      break;
    }
    case 'rtc-signal': {
      // Pass-through: the renderer is the WebRTC answerer, main just
      // shuttles SDP/ICE blobs between the phone and whichever window
      // has the preview open.
      type RtcSignalMsg = { type: 'rtc-signal'; payload: unknown };
      const m = msg as RtcSignalMsg;
      devices.emitRtcSignal(id, m.payload);
      break;
    }
    default:
      // silently ignore unknowns
      break;
  }
}

/** Send a raw JSON message to one device's WebSocket. Returns whether
 *  the socket accepted the write. */
export function sendToDevice(id: string, msg: unknown): boolean {
  return devices.sendTo(id, msg);
}
