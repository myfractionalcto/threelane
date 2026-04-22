import type { Platform } from './types';
import { electronPlatform } from './electron';
import { webPlatform } from './web';

/**
 * Pick the platform at runtime. Electron preload exposes `window.threelane`;
 * if it's missing we're in a plain browser tab (dev:web mode).
 */
export const platform: Platform =
  typeof window !== 'undefined' && window.threelane
    ? electronPlatform
    : webPlatform;

export type {
  CompanionDevice,
  CompanionDeviceEvent,
  CompanionDevicePhase,
  CompanionInfo,
  CursorSample,
  CursorTrack,
  LoadedProject,
  Platform,
  ScreenSource,
  ProjectHandle,
  ProjectManifest,
  TrackKind,
  TrackManifestEntry,
} from './types';
