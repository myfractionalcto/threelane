import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { MicOff, VideoOff } from 'lucide-react';

interface Props {
  stream: MediaStream | null;
  label: string;
  kind: 'video' | 'audio';
  muted?: boolean;
  className?: string;
}

/**
 * Shows a live preview of a MediaStream. Audio-only streams render a mic
 * level meter instead of a black video tile.
 */
export function PreviewTile({ stream, label, kind, muted = true, className }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (kind !== 'video') return;
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    return () => {
      el.srcObject = null;
    };
  }, [stream, kind]);

  return (
    <div
      className={cn(
        'relative rounded-xl overflow-hidden bg-black/60 border border-border aspect-video',
        className,
      )}
    >
      {kind === 'video' ? (
        stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={muted}
            className="absolute inset-0 w-full h-full object-contain bg-black"
          />
        ) : (
          <EmptyState icon={<VideoOff className="size-7" />} text="No video source" />
        )
      ) : stream ? (
        <MicMeter stream={stream} />
      ) : (
        <EmptyState icon={<MicOff className="size-7" />} text="No mic source" />
      )}
      <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md text-xs font-medium bg-background/80 backdrop-blur">
        {label}
      </div>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-2">
      {icon}
      <div className="text-xs">{text}</div>
    </div>
  );
}

/** Simple peak-level bar meter on an audio stream. */
function MicMeter({ stream }: { stream: MediaStream }) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      // peak-to-peak estimate
      let min = 255;
      let max = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const level = Math.min(1, (max - min) / 255);
      if (barRef.current) barRef.current.style.width = `${level * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      src.disconnect();
      ctx.close();
    };
  }, [stream]);

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="w-full h-3 bg-white/10 rounded-full overflow-hidden">
        <div
          ref={barRef}
          className="h-full bg-gradient-to-r from-green-500 via-yellow-400 to-red-500 transition-[width] duration-75"
          style={{ width: '0%' }}
        />
      </div>
    </div>
  );
}
