import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrackKind } from '@/platform';
import type { EditorProject } from './types';

/**
 * Timeline playback controller. Keeps a shared output-time (`playheadMs`),
 * and syncs each track's <video>/<audio> element's currentTime + play state
 * to match. The element refs are populated by the track pool; we only deal
 * in abstract `TrackKind → HTMLMediaElement` mappings.
 */
export type MediaMap = Partial<Record<TrackKind, HTMLMediaElement>>;

// Monitor volume persists across editor sessions — nothing is more
// annoying than re-setting it every time you reopen a project. Scope
// is the whole app (not per-project) since it's really about *your
// speakers* right now, not the content.
const VOLUME_STORAGE_KEY = 'threelane:previewVolume';
const MUTED_STORAGE_KEY = 'threelane:previewMuted';

function readStoredVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw == null) return 1;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0, n));
  } catch {
    return 1;
  }
}

function readStoredMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function usePlayback(project: EditorProject | null) {
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [volume, setVolumeState] = useState<number>(() => readStoredVolume());
  const [muted, setMutedState] = useState<boolean>(() => readStoredMuted());
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const lastTickRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const mediaRef = useRef<MediaMap>({});
  // Mirrored in refs so registerMedia can read current values on attach
  // without having to be re-created (and thus re-attach) every time the
  // slider moves.
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);

  const totalMs = project?.totalDurationMs ?? 0;

  // Flat, sorted list of trim ranges across all scenes — refreshed when
  // the project changes. Kept in a ref so the rAF tick doesn't need to
  // re-subscribe every edit; the tick reads the latest array on each
  // frame.
  const trimRangesRef = useRef<Array<{ start: number; end: number }>>([]);
  useEffect(() => {
    const flat: Array<{ start: number; end: number }> = [];
    if (project) {
      for (const s of project.scenes) {
        for (const c of s.trimClips) flat.push({ start: c.start, end: c.end });
      }
    }
    flat.sort((a, b) => a.start - b.start);
    trimRangesRef.current = flat;
  }, [project]);

  /** If `ms` lands inside a trim range, advance to the range's end.
   *  Handles back-to-back trims by scanning forward — rare in practice
   *  but cheap to do. Returns the adjusted ms. */
  const skipTrims = useCallback((ms: number): number => {
    let cur = ms;
    // A simple forward scan is fine — trimRangesRef is sorted and almost
    // always tiny (<10 entries). Breaks out as soon as no trim covers
    // `cur`.
    for (;;) {
      const hit = trimRangesRef.current.find(
        (r) => cur >= r.start && cur < r.end,
      );
      if (!hit) return cur;
      cur = hit.end;
    }
  }, []);

  const registerMedia = useCallback(
    (kind: TrackKind, el: HTMLMediaElement | null) => {
      if (el) {
        mediaRef.current[kind] = el;
        // Apply the current monitor volume/mute state to this freshly
        // attached element — otherwise a new scene's track pool would
        // play at full volume on its first frame until the slider is
        // touched. We read refs (not state) so this callback can stay
        // stable.
        try {
          el.volume = volumeRef.current;
          el.muted = mutedRef.current;
        } catch {
          // Safari iOS refuses programmatic volume changes; ignore.
        }
      } else {
        delete mediaRef.current[kind];
      }
    },
    [],
  );

  /**
   * Apply monitor volume + mute to every registered media element. Fires
   * on every change to either, and persists the new values so the editor
   * reopens at the same level next session.
   */
  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
    for (const el of Object.values(mediaRef.current)) {
      if (!el) continue;
      try {
        el.volume = volume;
        el.muted = muted;
      } catch {
        // Safari iOS — no-op.
      }
    }
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
      localStorage.setItem(MUTED_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // Private-mode or quota — ignore.
    }
  }, [volume, muted]);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolumeState(clamped);
    // Dragging the slider up from 0 is the obvious "un-mute" gesture —
    // honour it so the user doesn't have to also click the icon.
    if (clamped > 0) setMutedState(false);
  }, []);

  const toggleMute = useCallback(() => {
    setMutedState((m) => !m);
  }, []);

  /** Compute a track's offset in output-time. */
  const trackOffset = useCallback(
    (kind: TrackKind) => {
      const t = project?.tracks.find((x) => x.kind === kind);
      if (!t || !project) return 0;
      return t.startedAtMs - project.sessionStartMs;
    },
    [project],
  );

  /** Pause all media elements. */
  const pauseAll = useCallback(() => {
    for (const el of Object.values(mediaRef.current)) {
      if (el && !el.paused) el.pause();
    }
  }, []);

  /** Seek every media element to match the playhead. */
  const syncSeek = useCallback(
    (outputMs: number) => {
      if (!project) return;
      for (const t of project.tracks) {
        const el = mediaRef.current[t.kind];
        if (!el) continue;
        const localMs = outputMs - trackOffset(t.kind);
        const localSec = Math.max(0, localMs / 1000);
        // Clamp to the known duration so we don't seek past EOF. If duration
        // isn't known yet (WebM header has no duration), fall back to the
        // raw localSec — letting the video element accept it and resolve
        // once its own scan completes.
        const clamp =
          t.durationMs > 0 ? (t.durationMs - 1) / 1000 : localSec;
        const target = Math.min(localSec, Math.max(0, clamp));
        try {
          el.currentTime = target;
        } catch {
          // ignore seek errors
        }
      }
    },
    [project, trackOffset],
  );

  const seek = useCallback(
    (outputMs: number) => {
      // Don't auto-skip on a scrub — the user might be intentionally
      // parking inside a trim range to resize it. Preview still draws
      // the frame; it just won't auto-advance. The playback tick is the
      // only place we skip.
      const clamped = Math.max(0, Math.min(totalMs, outputMs));
      playheadRef.current = clamped;
      setPlayheadMs(clamped);
      syncSeek(clamped);
    },
    [syncSeek, totalMs],
  );

  const startRaf = useCallback(() => {
    if (rafRef.current !== null) return;
    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      if (!playingRef.current) {
        rafRef.current = null;
        return;
      }
      const dt = now - lastTickRef.current;
      lastTickRef.current = now;
      const advanced = Math.min(totalMs, playheadRef.current + dt);
      // If the advance landed inside a trim range, jump straight to the
      // range's end. We re-sync media seeks when this happens so the
      // <video> elements jump too — otherwise audio would keep playing
      // the trimmed-out portion for a tick.
      const next = skipTrims(advanced);
      if (next !== advanced) syncSeek(next);
      playheadRef.current = next;
      setPlayheadMs(next);
      if (next >= totalMs) {
        playingRef.current = false;
        setPlaying(false);
        pauseAll();
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [pauseAll, skipTrims, syncSeek, totalMs]);

  const play = useCallback(() => {
    if (!project) return;
    if (playheadRef.current >= totalMs) seek(0);
    // If the user hit Play while parked in a trim range, advance past
    // it first so the first tick doesn't try to sync to a frame that's
    // about to be skipped.
    const adjusted = skipTrims(playheadRef.current);
    if (adjusted !== playheadRef.current) {
      playheadRef.current = adjusted;
      setPlayheadMs(adjusted);
    }
    syncSeek(playheadRef.current);
    for (const t of project.tracks) {
      const el = mediaRef.current[t.kind];
      if (!el) continue;
      const localMs = playheadRef.current - trackOffset(t.kind);
      if (localMs < 0 || localMs > t.durationMs) continue;
      el.play().catch(() => {});
    }
    playingRef.current = true;
    setPlaying(true);
    startRaf();
  }, [project, seek, skipTrims, startRaf, syncSeek, totalMs, trackOffset]);

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    pauseAll();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [pauseAll]);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [play, pause, playing]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      pauseAll();
    },
    [pauseAll],
  );

  // Clamp playhead if project changes underneath (e.g. canvas swap).
  useEffect(() => {
    if (playheadRef.current > totalMs) seek(totalMs);
  }, [totalMs, seek]);

  return {
    playing,
    playheadMs,
    totalMs,
    volume,
    muted,
    play,
    pause,
    toggle,
    seek,
    setVolume,
    toggleMute,
    registerMedia,
    trackOffset,
    mediaRef,
  };
}
