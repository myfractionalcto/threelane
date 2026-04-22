import { protocol } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { projectsRoot } from './projects';

/**
 * `threelane-file://<project-id>/<filename>` — reads a file from within a
 * project folder and streams it to the renderer. Used because the renderer
 * is loaded from http://localhost (dev) or file:// (prod) and can't load
 * raw file:// URLs across origins.
 *
 * We deliberately do NOT serve anything outside ~/Movies/Threelane — the
 * path is resolved and compared so `../` escapes are rejected.
 *
 * HTTP Range support is mandatory here: without it Chromium marks the
 * <video> source as non-seekable (video.seekable ends up at 0), so
 * `currentTime = X` silently snaps back to frame 0 no matter what value
 * you assign. We previously delegated to `net.fetch(file://...)`, which
 * returns 200 OK with no Accept-Ranges and breaks seeking. This custom
 * handler parses `Range: bytes=a-b`, replies 206 with `Content-Range`,
 * and advertises `Accept-Ranges: bytes` on plain 200s.
 */

export function registerProjectFileProtocol() {
  protocol.handle('threelane-file', async (req) => {
    try {
      const url = new URL(req.url);
      // hostname = project id, pathname = /<file>
      const projectId = decodeURIComponent(url.hostname);
      const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const base = path.resolve(projectsRoot(), projectId);
      const full = path.resolve(base, file);
      // Path traversal check.
      if (!full.startsWith(base + path.sep) && full !== base) {
        return new Response('forbidden', { status: 403 });
      }

      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || !stat.isFile()) {
        return new Response('not found', { status: 404 });
      }
      const size = stat.size;
      const mime = mimeForPath(full);

      const rangeHeader =
        req.headers.get('range') ?? req.headers.get('Range');
      if (rangeHeader) {
        const parsed = parseRange(rangeHeader, size);
        if (!parsed) {
          return new Response('range not satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          });
        }
        const { start, end } = parsed;
        const length = end - start + 1;
        const body = nodeStreamToWeb(
          fs.createReadStream(full, { start, end }),
        );
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(length),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          },
        });
      }

      const body = nodeStreamToWeb(fs.createReadStream(full));
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      return new Response(
        `error: ${e instanceof Error ? e.message : String(e)}`,
        { status: 500 },
      );
    }
  });
}

/**
 * Called BEFORE app.ready to mark the scheme as privileged — required for
 * fetching media sources to work without CORS headaches.
 */
export function registerProjectFileSchemeAsPrivileged() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'threelane-file',
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        bypassCSP: true,
      },
    },
  ]);
}

/**
 * Parse a single `bytes=a-b` range header against a known file size.
 * Returns null for multi-range or unsatisfiable inputs — we only ever
 * need to handle the simple single-range case a <video> element issues.
 */
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const hasStart = m[1].length > 0;
  const hasEnd = m[2].length > 0;
  if (!hasStart && !hasEnd) return null;
  let start: number;
  let end: number;
  if (!hasStart) {
    // Suffix form: last N bytes.
    const suffix = parseInt(m[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= size) return null;
  if (end >= size) end = size - 1;
  if (start > end) return null;
  return { start, end };
}

function mimeForPath(p: string): string {
  const lower = p.toLowerCase();
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.jsonl')) return 'application/x-ndjson';
  return 'application/octet-stream';
}

/**
 * Bridge a Node Readable to a web ReadableStream so we can hand it to the
 * Response constructor. Node 18+ has `Readable.toWeb`, which is what we use
 * — the cast keeps TS happy across minor lib.dom variations.
 */
function nodeStreamToWeb(stream: Readable): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream;
}
