import { type RefObject } from 'react';
import { Loader2, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  /** videoRef is owned by the parent's usePhonePreview hook — we just
   *  attach it to the <video> element here. */
  videoRef: RefObject<HTMLVideoElement>;
  state: RTCPeerConnectionState | 'idle';
  label: string;
  className?: string;
}

/**
 * Main-grid live preview for a connected phone. Mirrors `PreviewTile`'s
 * visual idiom (rounded, bordered, aspect-video) so it sits beside Screen
 * and Camera without a visual seam. The actual peer-connection lifecycle
 * lives up in RecorderView via usePhonePreview — this component is view-
 * only.
 */
export function PhonePreviewTile({ videoRef, state, label, className }: Props) {
  const connected = state === 'connected';
  return (
    <div
      className={cn(
        // Portrait by default — phones are always held that way for
        // recording. Callers set their own flex/grid sizing hints via
        // className.
        'relative rounded-xl overflow-hidden bg-black/60 border border-border aspect-[9/16]',
        className,
      )}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-contain bg-black"
      />
      {!connected && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground bg-black/50">
          <Loader2 className="size-5 animate-spin" />
          <div className="text-xs">
            {state === 'idle' ? 'Starting preview…' : `Connecting (${state})…`}
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md text-xs font-medium bg-background/80 backdrop-blur inline-flex items-center gap-1.5">
        <Smartphone className="size-3" />
        {label}
      </div>
    </div>
  );
}
