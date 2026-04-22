import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';

/**
 * Scene-by-scene MP4 export.
 *
 * Strategy: render each scene to its own temp MP4 via a single ffmpeg
 * invocation (one complex filter graph), then concat all the scene MP4s
 * with the concat demuxer. This keeps each filter graph small and avoids
 * one-giant-graph debugging hell.
 *
 * Tradeoff: we transcode twice for long projects (once per scene, once for
 * concat). For v1 correctness > speed. We can switch to a single pass
 * later if exports feel slow.
 */

export interface ExportSourceTransform {
  fit: 'contain' | 'cover';
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface ExportRequest {
  projectId: string;
  projectName?: string;
  /** Absolute path chosen by the user via a save dialog. The IPC layer
   *  resolves this before calling exportProject — export never prompts. */
  outputPath: string;
  canvas: { width: number; height: number };
  scenes: {
    id: string;
    start: number;
    end: number;
    layout:
      | 'screen-only'
      | 'cam-only'
      | 'mobile-only'
      | 'split-horizontal'
      | 'screen-with-bubble';
    bubbleCorner: 'tl' | 'tr' | 'bl' | 'br';
    /** Which track fills the cam slot in split/bubble layouts. */
    secondarySource: 'cam' | 'mobile';
    audioSource: string | null;
    screenTransform: ExportSourceTransform;
    camTransform: ExportSourceTransform;
  }[];
  tracks: {
    id: string;
    offsetMs: number;
    durationMs: number;
    filePath?: string;
  }[];
  orientation: 'portrait' | 'landscape' | 'square';
}

/**
 * Filter sub-graph that frames a single source at target W×H, applying the
 * (fit, zoom, offsetX, offsetY) transform — equivalent to the canvas
 * compositor's `drawWithTransform` logic.
 *
 * 1. Build a black W×H background of the scene's duration.
 * 2. Scale source with fit flag at (W*zoom, H*zoom) — produces an image
 *    at least/at most covering the zoomed target.
 * 3. Overlay the scaled source on the background, centering it and
 *    shifting by offset * target dimensions.
 *
 * The overlay filter clips automatically to the background, so we don't
 * need an explicit crop step.
 */
function transformedSource(
  inputIdx: number,
  targetW: number,
  targetH: number,
  t: ExportSourceTransform,
  durationSec: number,
  suffix: string,
): { chain: string; outLabel: string } {
  const fitFlag =
    t.fit === 'cover'
      ? 'force_original_aspect_ratio=increase'
      : 'force_original_aspect_ratio=decrease';
  const zoom = Math.max(0.1, t.zoom);
  const zW = Math.max(1, Math.round(targetW * zoom));
  const zH = Math.max(1, Math.round(targetH * zoom));
  const offX = t.offsetX.toFixed(4);
  const offY = t.offsetY.toFixed(4);
  const bg = `bg_${suffix}`;
  const sc = `sc_${suffix}`;
  const fr = `fr_${suffix}`;
  // Overlay clips to the background bounds so anything panned off-frame
  // just disappears — same visual as the canvas compositor's target-rect
  // clipping.
  const chain =
    `color=c=black:s=${targetW}x${targetH}:d=${durationSec.toFixed(3)}[${bg}];` +
    `[${inputIdx}:v]scale=${zW}:${zH}:${fitFlag}[${sc}];` +
    `[${bg}][${sc}]overlay=` +
    `x=(${targetW}-w)/2+(${offX})*${targetW}:` +
    `y=(${targetH}-h)/2+(${offY})*${targetH}` +
    `[${fr}]`;
  return { chain, outLabel: `[${fr}]` };
}

function ffmpegBinary(): string {
  if (!ffmpegPath) throw new Error('ffmpeg binary not found');
  // In dev, ffmpegPath is absolute. In a packaged app it points inside
  // app.asar.unpacked (we'll configure electron-builder accordingly).
  return (ffmpegPath as unknown as string).replace(
    'app.asar',
    'app.asar.unpacked',
  );
}

function run(args: string[], logTag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${logTag} failed (code ${code}): ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Build the filter graph for one scene using the transform helper.
 * Video input indices (set by the caller) and which sources are present
 * are passed in. Produces a single `[outv]` labeled stream at canvas WxH.
 */
function sceneFilterGraph(
  scene: ExportRequest['scenes'][number],
  canvasW: number,
  canvasH: number,
  orientation: ExportRequest['orientation'],
  screenIdx: number | null,
  camIdx: number | null,
): string {
  const layout = scene.layout;
  const durSec = (scene.end - scene.start) / 1000;
  const finalBg =
    `color=c=black:s=${canvasW}x${canvasH}:d=${durSec.toFixed(3)},format=yuv420p[canvas_bg]`;

  if (layout === 'screen-only' && screenIdx !== null) {
    const { chain, outLabel } = transformedSource(
      screenIdx,
      canvasW,
      canvasH,
      scene.screenTransform,
      durSec,
      'screen',
    );
    // The transformed source is already canvas-sized — no further compositing.
    return `${chain};${outLabel}copy[outv]`;
  }
  if ((layout === 'cam-only' || layout === 'mobile-only') && camIdx !== null) {
    const { chain, outLabel } = transformedSource(
      camIdx,
      canvasW,
      canvasH,
      scene.camTransform,
      durSec,
      'cam',
    );
    return `${chain};${outLabel}copy[outv]`;
  }
  if (layout === 'split-horizontal' && screenIdx !== null && camIdx !== null) {
    const isPortrait = orientation === 'portrait' || orientation === 'square';
    const halfW = isPortrait ? canvasW : Math.floor(canvasW / 2);
    const halfH = isPortrait ? Math.floor(canvasH / 2) : canvasH;
    const s = transformedSource(screenIdx, halfW, halfH, scene.screenTransform, durSec, 'screen');
    const c = transformedSource(camIdx, halfW, halfH, scene.camTransform, durSec, 'cam');
    const layoutFilter = isPortrait
      ? `${s.outLabel}${c.outLabel}vstack=inputs=2[outv]`
      : `${s.outLabel}${c.outLabel}hstack=inputs=2[outv]`;
    return `${s.chain};${c.chain};${layoutFilter}`;
  }
  if (layout === 'screen-with-bubble' && screenIdx !== null && camIdx !== null) {
    const bubble = Math.floor(Math.min(canvasW, canvasH) * 0.25);
    const margin = Math.floor(Math.min(canvasW, canvasH) * 0.04);
    const x =
      scene.bubbleCorner === 'tr' || scene.bubbleCorner === 'br'
        ? canvasW - bubble - margin
        : margin;
    const y =
      scene.bubbleCorner === 'bl' || scene.bubbleCorner === 'br'
        ? canvasH - bubble - margin
        : margin;
    const s = transformedSource(
      screenIdx,
      canvasW,
      canvasH,
      scene.screenTransform,
      durSec,
      'screen',
    );
    const c = transformedSource(
      camIdx,
      bubble,
      bubble,
      scene.camTransform,
      durSec,
      'cam',
    );
    // Note: bubble is square here (not circular) for v1 — ffmpeg circular
    // masks need a geq alpha pass which we'll add later.
    return (
      `${s.chain};${c.chain};` +
      `${s.outLabel}${c.outLabel}overlay=${x}:${y}[outv]`
    );
  }
  // Fallback — solid black.
  return `${finalBg};[canvas_bg]copy[outv]`;
}

async function renderScene(
  scene: ExportRequest['scenes'][number],
  req: ExportRequest,
  workDir: string,
): Promise<string> {
  const canvasW = req.canvas.width;
  const canvasH = req.canvas.height;
  const durS = (scene.end - scene.start) / 1000;
  const screenTrack = req.tracks.find((t) => t.id === 'screen');
  const camTrack = req.tracks.find((t) => t.id === 'laptop-cam');
  const audioTrack = req.tracks.find((t) => t.id === scene.audioSource);

  const outFile = path.join(workDir, `${scene.id}.mp4`);
  const args: string[] = ['-y'];

  // Video inputs — trimmed at input with -ss / -t.
  const inputTrim = (track: { offsetMs: number; filePath?: string }) => {
    // Map scene-output time to track-local time.
    const localStart = Math.max(0, (scene.start - track.offsetMs) / 1000);
    return ['-ss', String(localStart), '-t', String(durS), '-i', track.filePath ?? ''];
  };

  // mobile-only always uses the mobile-cam track. Split and bubble let the
  // user pick between cam (laptop) and mobile via scene.secondarySource;
  // fall back to whichever exists if the pick's track is absent.
  const mobileTrack = req.tracks.find((t) => t.id === 'mobile-cam');
  const camSourceTrack = (() => {
    if (scene.layout === 'mobile-only') return mobileTrack ?? camTrack;
    if (
      scene.layout === 'split-horizontal' ||
      scene.layout === 'screen-with-bubble'
    ) {
      return scene.secondarySource === 'mobile'
        ? mobileTrack ?? camTrack
        : camTrack ?? mobileTrack;
    }
    return camTrack;
  })();

  let screenIdx: number | null = null;
  let camIdx: number | null = null;
  let nextIdx = 0;
  if (
    screenTrack?.filePath &&
    scene.layout !== 'cam-only' &&
    scene.layout !== 'mobile-only'
  ) {
    args.push(...inputTrim(screenTrack));
    screenIdx = nextIdx++;
  }
  if (camSourceTrack?.filePath && scene.layout !== 'screen-only') {
    args.push(...inputTrim(camSourceTrack));
    camIdx = nextIdx++;
  }

  let audioFilter = '';
  if (audioTrack?.filePath) {
    args.push(...inputTrim(audioTrack));
    audioFilter = `[${nextIdx}:a]aresample=44100,aformat=channel_layouts=stereo[outa]`;
  }

  const videoFilter = sceneFilterGraph(
    scene,
    canvasW,
    canvasH,
    req.orientation,
    screenIdx,
    camIdx,
  );
  const filter = audioFilter ? `${videoFilter};${audioFilter}` : videoFilter;

  args.push('-filter_complex', filter, '-map', '[outv]');
  if (audioFilter) args.push('-map', '[outa]');

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
  );
  if (audioFilter) args.push('-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-movflags', '+faststart', outFile);

  await run(args, `scene ${scene.id}`);
  return outFile;
}

export async function exportProject(req: ExportRequest): Promise<{ outputPath: string }> {
  if (req.scenes.length === 0) throw new Error('no scenes to export');
  if (!req.outputPath) throw new Error('outputPath required');

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'threelane-export-'));
  const sceneFiles: string[] = [];
  try {
    for (const scene of req.scenes) {
      sceneFiles.push(await renderScene(scene, req, workDir));
    }

    // Concat via demuxer — write a list file, pass to ffmpeg.
    const listFile = path.join(workDir, 'concat.txt');
    await fs.writeFile(
      listFile,
      sceneFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8',
    );

    await fs.mkdir(path.dirname(req.outputPath), { recursive: true });
    await run(
      ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', req.outputPath],
      'concat',
    );

    return { outputPath: req.outputPath };
  } finally {
    // Best-effort cleanup.
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {}
  }
}
