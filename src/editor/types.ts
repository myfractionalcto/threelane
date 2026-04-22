import type { CursorTrack, TrackKind } from '@/platform';

/**
 * Editor-internal data model. Distinct from the on-disk manifest — this
 * carries extra render-only state (object URLs, decoded durations) that
 * we never serialize.
 */

export type Orientation = 'portrait' | 'landscape' | 'square';

export interface CanvasSize {
  width: number;
  height: number;
  orientation: Orientation;
}

export const CANVAS_PRESETS: Record<Orientation, CanvasSize> = {
  portrait: { width: 1080, height: 1920, orientation: 'portrait' },
  landscape: { width: 1920, height: 1080, orientation: 'landscape' },
  square: { width: 1080, height: 1080, orientation: 'square' },
};

export type Layout =
  | 'screen-only'
  | 'cam-only'
  | 'mobile-only'
  | 'split-horizontal' // top/bottom on portrait, left/right on landscape
  | 'screen-with-bubble';

export type BubbleCorner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * How a source video is placed inside its target rect (the full canvas,
 * the top half, the bubble, etc.). Keeps the source separable from the
 * layout logic so the user can frame a landscape screen inside a portrait
 * canvas independently of which layout it's sitting in.
 */
export interface SourceTransform {
  /** contain = letterbox to fit, cover = fill + crop overflow. */
  fit: 'contain' | 'cover';
  /** Extra zoom multiplied on top of fit. 1 = no zoom. Range ~0.5..3. */
  zoom: number;
  /** Pan offset as a fraction of the target rect's width/height. */
  offsetX: number;
  offsetY: number;
  /** When true, override offsetX/Y at render time to follow the recorded
   *  cursor position (Electron-only; no effect if no cursor track loaded). */
  followCursor: boolean;
}

export const DEFAULT_TRANSFORM: SourceTransform = {
  fit: 'contain',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  followCursor: false,
};

export const DEFAULT_CAM_TRANSFORM: SourceTransform = {
  // Cam is almost always shot portrait-ish or close to 1:1 — cover reads
  // more naturally than letterbox.
  fit: 'cover',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  followCursor: false,
};

/** Which source "slot" a transform applies to inside a scene. */
export type SourceRole = 'screen' | 'cam';

/**
 * Which track fills the non-screen slot in `split-horizontal` and
 * `screen-with-bubble`. `cam` = laptop webcam track; `mobile` = phone
 * mobile-cam track. The same `camTransform` applies to whichever is
 * selected — they're conceptually interchangeable "second camera" slots.
 * Ignored for layouts that don't have a secondary slot (screen-only etc.).
 */
export type SecondarySource = 'cam' | 'mobile';

export interface EditorTrack {
  id: TrackKind;
  kind: TrackKind;
  /** One MediaSource per track; set in the track pool component. */
  url: string;
  mimeType: string;
  /** Wall-clock ms when recording began — determines timeline placement. */
  startedAtMs: number;
  /** Loaded lazily from the <video>/<audio> element. */
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface Scene {
  id: string;
  /** Output-time ms — always tile contiguously from 0 to end-of-project. */
  start: number;
  end: number;
  layout: Layout;
  bubbleCorner: BubbleCorner;
  /** Which track fills the cam slot for split/bubble layouts. */
  secondarySource: SecondarySource;
  /** TrackKind of the audio source; must be a track with hasAudio. */
  audioSource: TrackKind | null;
  /** Per-source placement. Unused roles in the current layout are ignored
   *  at render time but kept around so toggling layouts preserves framing. */
  screenTransform: SourceTransform;
  camTransform: SourceTransform;
}

export interface EditorProject {
  id: string;
  name?: string;
  location: string;
  createdAtMs: number;
  canvas: CanvasSize;
  tracks: EditorTrack[];
  scenes: Scene[];
  /** Derived: min of track.startedAtMs — treat as output t=0. */
  sessionStartMs: number;
  /** Derived: max (startedAtMs + durationMs) - sessionStartMs. */
  totalDurationMs: number;
  /** Present only if the recording captured a cursor track. */
  cursorTrack?: CursorTrack;
}

export function genSceneId(): string {
  return `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
