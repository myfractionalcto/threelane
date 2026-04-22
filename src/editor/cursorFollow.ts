import type { CursorTrack } from '@/platform';
import type { SourceTransform } from './types';

/**
 * Cursor-follow math. Given a cursor position in source coordinates and
 * the current fit/zoom, compute the `offsetX`/`offsetY` that centers the
 * zoomed view on the cursor, clamped to the source's pannable range.
 *
 * Kept separate from the compositor so the preview and (eventually) the
 * ffmpeg exporter can share it.
 */

/**
 * Binary-search the cursor track for the sample at time `ms` (ms from
 * recording start) and return a linearly interpolated {x, y} in cursor-
 * track coordinates (same as the recording's display DIP).
 */
export function cursorAt(track: CursorTrack, ms: number): { x: number; y: number } | null {
  const s = track.samples;
  if (s.length === 0) return null;
  if (ms <= s[0].t) return { x: s[0].x, y: s[0].y };
  if (ms >= s[s.length - 1].t) return { x: s[s.length - 1].x, y: s[s.length - 1].y };
  // Binary search for the last sample with t <= ms.
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (s[mid].t <= ms) lo = mid;
    else hi = mid - 1;
  }
  const a = s[lo];
  const b = s[Math.min(lo + 1, s.length - 1)];
  if (b.t === a.t) return { x: a.x, y: a.y };
  const f = (ms - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/**
 * Compute the offset that would center the zoomed view on `cursor`.
 *
 * Reverses the compositor's transform math:
 *   scaledSrcTopLeft_x = (targetW - scaledSrcW)/2 + offsetX * targetW
 *   cursorOnCanvas_x = scaledSrcTopLeft_x + cursor.x * scale
 * Setting cursorOnCanvas to target center gives:
 *   offsetX = (scale * (srcW/2 - cursor.x)) / targetW
 */
export function followOffset(
  cursor: { x: number; y: number },
  source: { width: number; height: number },
  target: { width: number; height: number },
  transform: SourceTransform,
): { offsetX: number; offsetY: number } {
  if (source.width === 0 || source.height === 0) {
    return { offsetX: 0, offsetY: 0 };
  }
  const fitScale =
    transform.fit === 'cover'
      ? Math.max(target.width / source.width, target.height / source.height)
      : Math.min(target.width / source.width, target.height / source.height);
  const scale = fitScale * transform.zoom;
  const scaledW = source.width * scale;
  const scaledH = source.height * scale;

  const desiredX = (scale * (source.width / 2 - cursor.x)) / target.width;
  const desiredY = (scale * (source.height / 2 - cursor.y)) / target.height;

  // Clamp so the viewport stays inside the source — no bouncing off into
  // black bars when the cursor approaches an edge.
  const maxX = Math.max(0, (scaledW - target.width) / (2 * target.width));
  const maxY = Math.max(0, (scaledH - target.height) / (2 * target.height));
  return {
    offsetX: Math.max(-maxX, Math.min(maxX, desiredX)),
    offsetY: Math.max(-maxY, Math.min(maxY, desiredY)),
  };
}

/**
 * Exponential smoothing — nudges `prev` toward `target` by a fixed
 * fraction. Call per frame.
 */
export function smoothOffset(
  prev: { x: number; y: number },
  target: { offsetX: number; offsetY: number },
  alpha = 0.15,
): { x: number; y: number } {
  return {
    x: prev.x + alpha * (target.offsetX - prev.x),
    y: prev.y + alpha * (target.offsetY - prev.y),
  };
}
