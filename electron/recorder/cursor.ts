import { screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Records the global cursor position while the screen is being captured.
 * Electron's `screen.getCursorScreenPoint()` reports the cursor in
 * device-independent pixels on whichever display the cursor is on —
 * good enough for full-screen captures of the primary display (v1).
 *
 * File format: newline-delimited JSON. First line is a header with display
 * info; subsequent lines are `{ t, x, y }` samples at ~30 Hz, where `t` is
 * ms since recording start.
 */

const POLL_HZ = 30;

interface Tracker {
  stream: fs.WriteStream;
  timer: NodeJS.Timeout;
  startedAtMs: number;
}

const trackers = new Map<string, Tracker>();

export async function startCursorTracking(
  projectId: string,
  projectDir: string,
  startedAtMs: number,
): Promise<string> {
  // If already tracking (reentrant call), stop the old one cleanly.
  if (trackers.has(projectId)) {
    await stopCursorTracking(projectId);
  }
  const file = path.join(projectDir, 'cursor.jsonl');
  const stream = fs.createWriteStream(file, { flags: 'w' });

  const display = screen.getPrimaryDisplay();
  const header =
    JSON.stringify({
      kind: 'header',
      display: {
        bounds: display.bounds, // in DIP
        size: display.size,
        scaleFactor: display.scaleFactor,
      },
      pollHz: POLL_HZ,
      startedAtMs,
    }) + '\n';
  stream.write(header);

  const timer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const line = JSON.stringify({ t: Date.now() - startedAtMs, x: p.x, y: p.y }) + '\n';
    stream.write(line);
  }, Math.round(1000 / POLL_HZ));

  trackers.set(projectId, { stream, timer, startedAtMs });
  return 'cursor.jsonl';
}

export async function stopCursorTracking(projectId: string): Promise<string | null> {
  const t = trackers.get(projectId);
  if (!t) return null;
  clearInterval(t.timer);
  await new Promise<void>((resolve, reject) => {
    t.stream.end((err: unknown) => (err ? reject(err) : resolve()));
  });
  trackers.delete(projectId);
  return 'cursor.jsonl';
}

/**
 * Loads cursor.jsonl for a project and returns a normalized cursor track.
 * Missing file → returns null. Parse errors on individual lines are
 * skipped (we don't want one corrupt line to kill playback).
 */
export async function loadCursorTrack(projectDir: string): Promise<{
  display: { width: number; height: number; scaleFactor: number };
  samples: { t: number; x: number; y: number }[];
} | null> {
  const file = path.join(projectDir, 'cursor.jsonl');
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const header = JSON.parse(lines[0]);
    if (header.kind !== 'header') return null;
    const samples: { t: number; x: number; y: number }[] = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        const s = JSON.parse(lines[i]);
        if (typeof s.t === 'number' && typeof s.x === 'number' && typeof s.y === 'number') {
          samples.push({ t: s.t, x: s.x, y: s.y });
        }
      } catch {
        // skip corrupt line
      }
    }
    return {
      display: {
        width: header.display.bounds.width,
        height: header.display.bounds.height,
        scaleFactor: header.display.scaleFactor,
      },
      samples,
    };
  } catch {
    return null;
  }
}
