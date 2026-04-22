import type {
  BubbleCorner,
  CanvasSize,
  Layout,
  SecondarySource,
  SourceTransform,
} from './types';

/**
 * Pure rendering function: draws one frame into a canvas given the current
 * scene layout and the source <video> elements. Called every rAF tick
 * during playback and on demand during scrubbing.
 *
 * Keep this deterministic — same inputs, same output. Used by both the
 * on-screen preview and the ffmpeg export (via an equivalent filter graph).
 */

export interface CompositeSources {
  screen: HTMLVideoElement | null;
  cam: HTMLVideoElement | null;
  mobile: HTMLVideoElement | null;
}

const BUBBLE_SIZE_RATIO = 0.25; // bubble's longest side = 25% of canvas
const BUBBLE_MARGIN_RATIO = 0.04;

/**
 * Compute the draw rect + source sub-rect for a transform. Matches the
 * math the ffmpeg exporter uses so preview and export agree.
 */
export function computeDrawRect(
  srcW: number,
  srcH: number,
  targetX: number,
  targetY: number,
  targetW: number,
  targetH: number,
  t: SourceTransform,
) {
  if (srcW === 0 || srcH === 0) {
    return { sx: 0, sy: 0, sw: 0, sh: 0, dx: targetX, dy: targetY, dw: 0, dh: 0 };
  }
  // Base scale by fit mode.
  const fitScale =
    t.fit === 'cover'
      ? Math.max(targetW / srcW, targetH / srcH)
      : Math.min(targetW / srcW, targetH / srcH);
  const scale = fitScale * t.zoom;

  // Scaled source dimensions in canvas units.
  const scaledW = srcW * scale;
  const scaledH = srcH * scale;

  // Center of target rect, shifted by normalized pan.
  const cx = targetX + targetW / 2 + t.offsetX * targetW;
  const cy = targetY + targetH / 2 + t.offsetY * targetH;

  // Top-left of where scaled source would land.
  const dx = cx - scaledW / 2;
  const dy = cy - scaledH / 2;

  // Clip draw rect to target rect. We do this by computing overlap and
  // back-projecting into source coordinates.
  const clippedLeft = Math.max(targetX, dx);
  const clippedTop = Math.max(targetY, dy);
  const clippedRight = Math.min(targetX + targetW, dx + scaledW);
  const clippedBottom = Math.min(targetY + targetH, dy + scaledH);
  const dw = Math.max(0, clippedRight - clippedLeft);
  const dh = Math.max(0, clippedBottom - clippedTop);

  // How far into the scaled source we're sampling from.
  const offLeft = clippedLeft - dx;
  const offTop = clippedTop - dy;

  const sx = offLeft / scale;
  const sy = offTop / scale;
  const sw = dw / scale;
  const sh = dh / scale;

  return {
    sx,
    sy,
    sw,
    sh,
    dx: clippedLeft,
    dy: clippedTop,
    dw,
    dh,
  };
}

function drawWithTransform(
  ctx: CanvasRenderingContext2D,
  v: HTMLVideoElement,
  tx: number,
  ty: number,
  tw: number,
  th: number,
  t: SourceTransform,
) {
  const r = computeDrawRect(v.videoWidth, v.videoHeight, tx, ty, tw, th, t);
  if (r.dw <= 0 || r.dh <= 0) return;
  ctx.drawImage(v, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
}

export function composite(
  ctx: CanvasRenderingContext2D,
  canvas: CanvasSize,
  layout: Layout,
  bubble: BubbleCorner,
  secondary: SecondarySource,
  sources: CompositeSources,
  screenT: SourceTransform,
  camT: SourceTransform,
) {
  const { width: W, height: H } = canvas;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const { screen, cam, mobile } = sources;
  const isPortrait = canvas.orientation === 'portrait';
  // The secondary slot (split/bubble) is either the laptop webcam or the
  // phone, driven by scene.secondarySource. Fall back to whichever source
  // actually exists if the chosen one is missing — this matters right
  // after switching layouts before the user has picked.
  const secondaryEl =
    secondary === 'mobile' ? mobile ?? cam : cam ?? mobile;

  switch (layout) {
    case 'screen-only':
      if (screen) drawWithTransform(ctx, screen, 0, 0, W, H, screenT);
      break;
    case 'cam-only':
      if (cam) drawWithTransform(ctx, cam, 0, 0, W, H, camT);
      break;
    case 'mobile-only':
      // Reuse camT — phone is conceptually "another camera" for framing.
      if (mobile) drawWithTransform(ctx, mobile, 0, 0, W, H, camT);
      break;
    case 'split-horizontal': {
      if (isPortrait) {
        const h = H / 2;
        if (screen) drawWithTransform(ctx, screen, 0, 0, W, h, screenT);
        if (secondaryEl) drawWithTransform(ctx, secondaryEl, 0, h, W, h, camT);
      } else {
        const w = W / 2;
        if (screen) drawWithTransform(ctx, screen, 0, 0, w, H, screenT);
        if (secondaryEl) drawWithTransform(ctx, secondaryEl, w, 0, w, H, camT);
      }
      break;
    }
    case 'screen-with-bubble': {
      if (screen) drawWithTransform(ctx, screen, 0, 0, W, H, screenT);
      if (secondaryEl) {
        const longSide = Math.min(W, H) * BUBBLE_SIZE_RATIO;
        const margin = Math.min(W, H) * BUBBLE_MARGIN_RATIO;
        const bw = longSide;
        const bh = longSide;
        const bx = bubble === 'tr' || bubble === 'br' ? W - bw - margin : margin;
        const by = bubble === 'bl' || bubble === 'br' ? H - bh - margin : margin;
        ctx.save();
        ctx.beginPath();
        ctx.arc(bx + bw / 2, by + bh / 2, bw / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        drawWithTransform(ctx, secondaryEl, bx, by, bw, bh, camT);
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = Math.max(2, longSide * 0.02);
        ctx.beginPath();
        ctx.arc(bx + bw / 2, by + bh / 2, bw / 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
  }
}

/**
 * Which source role is the "primary" (draggable) one in a layout?
 * Used to decide what drag-on-preview should pan.
 */
export function primaryRole(layout: Layout): 'screen' | 'cam' | null {
  switch (layout) {
    case 'screen-only':
    case 'screen-with-bubble':
      return 'screen';
    case 'cam-only':
    case 'mobile-only':
      return 'cam';
    case 'split-horizontal':
      // ambiguous — top/left source wins as "primary" for drag purposes.
      return 'screen';
  }
}

/**
 * Target rect (in canvas pixels) occupied by a given role in a layout.
 * Used by drag-on-preview to convert pixel deltas to normalized offsets.
 */
export function roleTargetRect(
  role: 'screen' | 'cam',
  layout: Layout,
  canvas: CanvasSize,
): { x: number; y: number; w: number; h: number } {
  const W = canvas.width;
  const H = canvas.height;
  const isPortrait = canvas.orientation === 'portrait';

  if (layout === 'screen-only') return role === 'screen' ? { x: 0, y: 0, w: W, h: H } : { x: 0, y: 0, w: 0, h: 0 };
  if (layout === 'cam-only' || layout === 'mobile-only')
    return role === 'cam' ? { x: 0, y: 0, w: W, h: H } : { x: 0, y: 0, w: 0, h: 0 };
  if (layout === 'screen-with-bubble') {
    if (role === 'screen') return { x: 0, y: 0, w: W, h: H };
    const longSide = Math.min(W, H) * BUBBLE_SIZE_RATIO;
    return { x: 0, y: 0, w: longSide, h: longSide };
  }
  // split-horizontal
  if (isPortrait) {
    const h = H / 2;
    return role === 'screen' ? { x: 0, y: 0, w: W, h } : { x: 0, y: h, w: W, h };
  }
  const w = W / 2;
  return role === 'screen' ? { x: 0, y: 0, w, h: H } : { x: w, y: 0, w, h: H };
}
