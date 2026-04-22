import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { MediaMap } from './usePlayback';
import { composite, primaryRole, roleTargetRect } from './compositor';
import { cursorAt, followOffset, smoothOffset } from './cursorFollow';
import type { EditorProject, Scene, SourceRole, SourceTransform } from './types';

interface Props {
  project: EditorProject;
  scene: Scene | null;
  mediaRef: React.MutableRefObject<MediaMap>;
  playing: boolean;
  /** Current output-time ms. Needed for cursor-follow lookup. */
  playheadMs: number;
  onPan?: (role: SourceRole, patch: Partial<SourceTransform>) => void;
}

export interface PreviewHandle {
  canvas: HTMLCanvasElement | null;
}

/**
 * Canvas preview. Composites all sources every rAF. Drag on the preview
 * pans the layout's primary source (screen in screen-only / with-bubble /
 * split, cam in cam-only) — same gesture as OpenScreen.
 */
export const Preview = forwardRef<PreviewHandle, Props>(function Preview(
  { project, scene, mediaRef, playing, playheadMs, onPan },
  outerRef,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef(playheadMs);
  playheadRef.current = playheadMs;
  // Smoothed cursor-follow offset carried across frames. Reset on scene change.
  const followRef = useRef<{ x: number; y: number; sceneId: string | null }>({
    x: 0,
    y: 0,
    sceneId: null,
  });

  useImperativeHandle(outerRef, () => ({
    get canvas() {
      return canvasRef.current;
    },
  }));

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = project.canvas.width;
    c.height = project.canvas.height;
  }, [project.canvas.width, project.canvas.height]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    // Always composite at the rAF cadence. We tried gating this on
    // "playhead changed since last draw" to save CPU while paused, but
    // setting `video.currentTime` is asynchronous — the new frame isn't
    // decoded yet on the rAF tick the seek happens. Skipping subsequent
    // ticks meant the canvas was stuck on whatever frame happened to be
    // decoded last (usually frame 0). Drawing every tick is the only
    // race-free way to catch the new frame whenever it lands. The
    // downstream cost is bounded — most seeks complete in <50ms once the
    // WebM is remuxed at finalize time.
    const draw = () => {
      const s = scene;
      if (s) {
        const screen = mediaRef.current['screen'];
        const cam = mediaRef.current['laptop-cam'];
        const mobile = mediaRef.current['mobile-cam'];
        // Resolve the active transform for the screen source. If
        // followCursor is on and we have a cursor track, override offsetX/Y
        // to center the zoomed view on the cursor (with smoothing).
        let screenTransform = s.screenTransform;
        const scrEl = screen as HTMLVideoElement | undefined;
        if (
          s.screenTransform.followCursor &&
          project.cursorTrack &&
          scrEl &&
          scrEl.videoWidth > 0
        ) {
          // Reset smoothing state on scene change to avoid a big jump.
          if (followRef.current.sceneId !== s.id) {
            followRef.current = { x: s.screenTransform.offsetX, y: s.screenTransform.offsetY, sceneId: s.id };
          }
          // Cursor time is in the screen-track's local time, not output time.
          const screenTrack = project.tracks.find((t) => t.kind === 'screen');
          const screenOffsetMs = screenTrack
            ? screenTrack.startedAtMs - project.sessionStartMs
            : 0;
          const trackMs = playheadRef.current - screenOffsetMs;
          const raw = cursorAt(project.cursorTrack, trackMs);
          if (raw) {
            // Cursor is in recording display DIP; scale to source pixels.
            const track = project.cursorTrack;
            const srcW = scrEl.videoWidth;
            const srcH = scrEl.videoHeight;
            const cursorInSrc = {
              x: raw.x * (srcW / track.display.width),
              y: raw.y * (srcH / track.display.height),
            };
            const target = followOffset(
              cursorInSrc,
              { width: srcW, height: srcH },
              { width: project.canvas.width, height: project.canvas.height },
              s.screenTransform,
            );
            const smoothed = smoothOffset(
              { x: followRef.current.x, y: followRef.current.y },
              target,
            );
            followRef.current.x = smoothed.x;
            followRef.current.y = smoothed.y;
            screenTransform = {
              ...s.screenTransform,
              offsetX: smoothed.x,
              offsetY: smoothed.y,
            };
          }
        } else {
          followRef.current.sceneId = null;
        }

        composite(
          ctx,
          project.canvas,
          s.layout,
          s.bubbleCorner,
          s.secondarySource,
          {
            screen: scrEl ?? null,
            cam: (cam as HTMLVideoElement | undefined) ?? null,
            mobile: (mobile as HTMLVideoElement | undefined) ?? null,
          },
          screenTransform,
          s.camTransform,
        );
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [project.canvas, project.cursorTrack, project.tracks, project.sessionStartMs, scene, mediaRef, playing]);

  // Drag-to-pan on the canvas.
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    role: SourceRole;
    targetW: number;
    targetH: number;
    canvasPxPerUnit: number;
  } | null>(null);

  const onCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!scene || !onPan) return;
      const role = primaryRole(scene.layout);
      if (!role) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      // Each CSS pixel corresponds to this many canvas units.
      const canvasPxPerUnit = rect.width / project.canvas.width;
      const target = roleTargetRect(role, scene.layout, project.canvas);
      const transform = role === 'screen' ? scene.screenTransform : scene.camTransform;
      dragStateRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: transform.offsetX,
        baseY: transform.offsetY,
        role,
        targetW: target.w,
        targetH: target.h,
        canvasPxPerUnit,
      };
      (e.target as HTMLElement).style.cursor = 'grabbing';
      e.preventDefault();
    },
    [scene, onPan, project.canvas],
  );

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const d = dragStateRef.current;
      if (!d || !onPan) return;
      // Pixel delta in CSS → canvas units → fraction of target rect.
      const dxCanvas = (e.clientX - d.startX) / d.canvasPxPerUnit;
      const dyCanvas = (e.clientY - d.startY) / d.canvasPxPerUnit;
      const offsetX = d.baseX + dxCanvas / d.targetW;
      const offsetY = d.baseY + dyCanvas / d.targetH;
      onPan(d.role, { offsetX, offsetY });
    };
    const handleUp = () => {
      if (dragStateRef.current) {
        dragStateRef.current = null;
        if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [onPan]);

  return (
    <div
      ref={wrapRef}
      className="flex-1 min-h-0 min-w-0 flex items-center justify-center bg-black/40 rounded-xl overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        onMouseDown={onCanvasMouseDown}
        className="block"
        style={{
          aspectRatio: `${project.canvas.width} / ${project.canvas.height}`,
          maxWidth: '100%',
          maxHeight: '100%',
          width: 'auto',
          height: 'auto',
          objectFit: 'contain',
          cursor: onPan && scene ? 'grab' : 'default',
        }}
      />
    </div>
  );
});
