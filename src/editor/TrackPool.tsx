import { useEffect, useRef } from 'react';
import type { EditorTrack } from './types';
import type { TrackKind } from '@/platform';

/**
 * Hidden <video>/<audio> elements — one per track. Refs are bubbled up so
 * the compositor can sample frames from videos and the playback controller
 * can drive currentTime.
 *
 * Kept out of the visible DOM tree because the preview canvas is the user-
 * facing thing. The media elements exist only as frame sources.
 */
interface Props {
  tracks: EditorTrack[];
  sceneAudioSource: TrackKind | null;
  onMediaReady: (kind: TrackKind, el: HTMLMediaElement | null) => void;
  onDurationKnown: (kind: TrackKind, durationMs: number) => void;
}

export function TrackPool({
  tracks,
  sceneAudioSource,
  onMediaReady,
  onDurationKnown,
}: Props) {
  return (
    <div className="sr-only" aria-hidden>
      {tracks.map((t) =>
        t.hasVideo ? (
          <TrackVideo
            key={t.id}
            track={t}
            muted={sceneAudioSource !== t.kind}
            onReady={onMediaReady}
            onDuration={onDurationKnown}
          />
        ) : (
          <TrackAudio
            key={t.id}
            track={t}
            muted={sceneAudioSource !== t.kind}
            onReady={onMediaReady}
            onDuration={onDurationKnown}
          />
        ),
      )}
    </div>
  );
}

function TrackVideo({
  track,
  muted,
  onReady,
  onDuration,
}: {
  track: EditorTrack;
  muted: boolean;
  onReady: (kind: TrackKind, el: HTMLMediaElement | null) => void;
  onDuration: (kind: TrackKind, durationMs: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    onReady(track.kind, ref.current);
    return () => onReady(track.kind, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  return (
    <video
      ref={ref}
      src={track.url}
      muted={muted}
      preload="auto"
      playsInline
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        // MediaRecorder WebM often reports `Infinity` here (no duration in the
        // header). We also listen to `durationchange` below to pick up the
        // real value once the element has scanned the file.
        if (Number.isFinite(d) && d > 0) onDuration(track.kind, d * 1000);
      }}
      onDurationChange={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d) && d > 0) onDuration(track.kind, d * 1000);
      }}
    />
  );
}

function TrackAudio({
  track,
  muted,
  onReady,
  onDuration,
}: {
  track: EditorTrack;
  muted: boolean;
  onReady: (kind: TrackKind, el: HTMLMediaElement | null) => void;
  onDuration: (kind: TrackKind, durationMs: number) => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    onReady(track.kind, ref.current);
    return () => onReady(track.kind, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  return (
    <audio
      ref={ref}
      src={track.url}
      muted={muted}
      preload="auto"
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d) && d > 0) onDuration(track.kind, d * 1000);
      }}
      onDurationChange={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d) && d > 0) onDuration(track.kind, d * 1000);
      }}
    />
  );
}
