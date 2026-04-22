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

export function usePlayback(project: EditorProject | null) {
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const lastTickRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const mediaRef = useRef<MediaMap>({});

  const totalMs = project?.totalDurationMs ?? 0;

  const registerMedia = useCallback(
    (kind: TrackKind, el: HTMLMediaElement | null) => {
      if (el) mediaRef.current[kind] = el;
      else delete mediaRef.current[kind];
    },
    [],
  );

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
      const next = Math.min(totalMs, playheadRef.current + dt);
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
  }, [pauseAll, totalMs]);

  const play = useCallback(() => {
    if (!project) return;
    if (playheadRef.current >= totalMs) seek(0);
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
  }, [project, seek, startRaf, syncSeek, totalMs, trackOffset]);

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
    play,
    pause,
    toggle,
    seek,
    registerMedia,
    trackOffset,
    mediaRef,
  };
}
