import type {
  ExportRequest,
  ExportResult,
  LoadedProject,
  Platform,
  ProjectHandle,
  ProjectManifest,
  ScreenSource,
  TrackKind,
} from './types';

/**
 * Browser-only platform. Runs off localhost during development so we can
 * iterate on the recorder UI without rebuilding the Electron app every change.
 *
 * Storage model: buffers every track in memory, then offers the finalized
 * files as browser downloads when the project stops. This is good enough
 * for UI-level testing. The full on-disk experience requires Electron.
 */

interface TrackBuffer {
  chunks: Uint8Array[];
  mimeType: string;
}

const buffers = new Map<string, TrackBuffer>(); // key = `${projectId}/${trackId}`

function key(projectId: string, trackId: TrackKind) {
  return `${projectId}/${trackId}`;
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download can start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function extFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'bin';
}

export const webPlatform: Platform = {
  kind: 'web',

  async listScreenSources(): Promise<ScreenSource[]> {
    // Browser can't enumerate screens up-front — `getDisplayMedia` pops its
    // own picker at capture time. Return a single synthetic entry so the UI
    // has something to select.
    return [{ id: 'web:picker', name: 'Choose in browser dialog…' }];
  },

  async captureScreen(_sourceId: string | null): Promise<MediaStream> {
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false, // system audio skipped for v1
    });
  },

  async startProject(): Promise<ProjectHandle> {
    const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return { id, location: 'Browser downloads folder' };
  },

  async writeTrackChunk(
    projectId: string,
    trackId: TrackKind,
    mimeType: string,
    chunk: ArrayBuffer,
  ): Promise<void> {
    const k = key(projectId, trackId);
    let buf = buffers.get(k);
    if (!buf) {
      buf = { chunks: [], mimeType };
      buffers.set(k, buf);
    }
    buf.chunks.push(new Uint8Array(chunk));
  },

  async finalizeTrack(projectId: string, trackId: TrackKind): Promise<string> {
    const k = key(projectId, trackId);
    const buf = buffers.get(k);
    if (!buf) throw new Error(`no buffer for ${k}`);
    const blob = new Blob(buf.chunks as BlobPart[], { type: buf.mimeType });
    const filename = `${projectId}_${trackId}.${extFor(buf.mimeType)}`;
    downloadBlob(filename, blob);
    buffers.delete(k);
    return filename;
  },

  async finalizeProject(
    projectId: string,
    manifest: ProjectManifest,
  ): Promise<string> {
    const blob = new Blob([JSON.stringify(manifest, null, 2)], {
      type: 'application/json',
    });
    downloadBlob(`${projectId}_manifest.json`, blob);
    return manifest.id;
  },

  async startCursorTracking() {
    // Browsers can't see the cursor outside the tab — skip silently so the
    // recorder doesn't need to branch on platform.kind.
    return null;
  },

  async stopCursorTracking() {
    return null;
  },

  async companionStart() {
    // A browser tab can't open a server; the studio will show a
    // "desktop-only" hint instead of the QR.
    return null;
  },
  async companionSetCurrentProject() {},
  async companionBroadcastStart() {},
  async companionBroadcastStop() {},
  async companionWaitForUploads() {
    return [];
  },
  companionSubscribe() {
    return () => {};
  },
  async companionSendToDevice() {
    // Web has no peers — WebRTC preview is Electron-only.
    return false;
  },

  async listProjects() {
    // Browser has no persisted project list — you always re-open from files.
    return [];
  },

  async deleteProject(): Promise<void> {
    // Nothing persisted in the browser — recordings live as user downloads.
  },

  async openProject(): Promise<LoadedProject | null> {
    // Prompt the user to pick the manifest.json + track files together.
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.json,.webm,.mp4,.ogg';
    return new Promise((resolve) => {
      input.onchange = async () => {
        const files = Array.from(input.files ?? []);
        if (files.length === 0) return resolve(null);
        const manifestFile = files.find((f) => f.name.endsWith('manifest.json'));
        if (!manifestFile) {
          alert('Pick the manifest.json plus the track files together.');
          return resolve(null);
        }
        try {
          const manifest: ProjectManifest = JSON.parse(await manifestFile.text());
          const trackUrls: Record<string, string> = {};
          for (const entry of manifest.tracks) {
            // Track's `file` field is a bare filename; match by suffix of file name.
            const match = files.find((f) => f.name.endsWith(entry.file));
            if (match) trackUrls[entry.id] = URL.createObjectURL(match);
          }
          resolve({
            manifest,
            trackUrls,
            location: `Browser upload (${files.length} files)`,
          });
        } catch (e) {
          console.error('failed to parse manifest', e);
          resolve(null);
        }
      };
      input.click();
    });
  },

  async exportProject(_req: ExportRequest): Promise<ExportResult> {
    // Real export happens in Electron. In the browser we surface this as an
    // explicit limitation — the canvas-capture fallback lives in the editor
    // view so it can drive the preview canvas and timeline itself.
    throw new Error(
      'Export to MP4 is only available in the desktop app. Use the web editor for preview and planning.',
    );
  },
};
