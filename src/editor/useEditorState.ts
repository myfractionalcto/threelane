import { useCallback, useMemo, useState } from 'react';
import type { TrackKind } from '@/platform';
import {
  CANVAS_PRESETS,
  DEFAULT_CAM_TRANSFORM,
  DEFAULT_TRANSFORM,
  genSceneId,
  type BubbleCorner,
  type CanvasSize,
  type EditorProject,
  type Layout,
  type Orientation,
  type Scene,
  type SecondarySource,
  type SourceRole,
  type SourceTransform,
} from './types';

/**
 * Single source of truth for the editor. Keeps project immutable-ish
 * (setState replaces), provides typed mutators for the operations the UI
 * actually performs. Undo/redo intentionally deferred.
 */
export function useEditorState(initial: EditorProject | null) {
  const [project, setProject] = useState<EditorProject | null>(initial);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);

  const selectedScene = useMemo(
    () => project?.scenes.find((s) => s.id === selectedSceneId) ?? null,
    [project, selectedSceneId],
  );

  const setCanvas = useCallback((orientation: Orientation) => {
    setProject((p) => (p ? { ...p, canvas: CANVAS_PRESETS[orientation] } : p));
  }, []);

  const setSceneLayout = useCallback((sceneId: string, layout: Layout) => {
    setProject((p) =>
      p
        ? {
            ...p,
            scenes: p.scenes.map((s) => (s.id === sceneId ? { ...s, layout } : s)),
          }
        : p,
    );
  }, []);

  const setSceneAudioSource = useCallback(
    (sceneId: string, audioSource: TrackKind | null) => {
      setProject((p) =>
        p
          ? {
              ...p,
              scenes: p.scenes.map((s) =>
                s.id === sceneId ? { ...s, audioSource } : s,
              ),
            }
          : p,
      );
    },
    [],
  );

  const setSceneBubble = useCallback(
    (sceneId: string, bubbleCorner: BubbleCorner) => {
      setProject((p) =>
        p
          ? {
              ...p,
              scenes: p.scenes.map((s) =>
                s.id === sceneId ? { ...s, bubbleCorner } : s,
              ),
            }
          : p,
      );
    },
    [],
  );

  const setSceneSecondarySource = useCallback(
    (sceneId: string, secondarySource: SecondarySource) => {
      setProject((p) =>
        p
          ? {
              ...p,
              scenes: p.scenes.map((s) =>
                s.id === sceneId ? { ...s, secondarySource } : s,
              ),
            }
          : p,
      );
    },
    [],
  );

  /** Update one field of a source transform. Caller supplies a partial patch. */
  const updateSceneTransform = useCallback(
    (sceneId: string, role: SourceRole, patch: Partial<SourceTransform>) => {
      setProject((p) => {
        if (!p) return p;
        return {
          ...p,
          scenes: p.scenes.map((s) => {
            if (s.id !== sceneId) return s;
            const key = role === 'screen' ? 'screenTransform' : 'camTransform';
            return { ...s, [key]: { ...s[key], ...patch } };
          }),
        };
      });
    },
    [],
  );

  const resetSceneTransform = useCallback(
    (sceneId: string, role: SourceRole) => {
      setProject((p) => {
        if (!p) return p;
        const defaults = role === 'screen' ? DEFAULT_TRANSFORM : DEFAULT_CAM_TRANSFORM;
        return {
          ...p,
          scenes: p.scenes.map((s) => {
            if (s.id !== sceneId) return s;
            const key = role === 'screen' ? 'screenTransform' : 'camTransform';
            return { ...s, [key]: { ...defaults } };
          }),
        };
      });
    },
    [],
  );

  /**
   * Split the scene containing `atMs` into two at that position. The new
   * scene inherits all properties from the original (including transforms,
   * via a deep copy so subsequent edits don't mutate the sibling).
   */
  const splitAt = useCallback((atMs: number) => {
    setProject((p) => {
      if (!p) return p;
      const idx = p.scenes.findIndex((s) => atMs > s.start && atMs < s.end);
      if (idx < 0) return p;
      const original = p.scenes[idx];
      const right: Scene = {
        ...original,
        id: genSceneId(),
        start: atMs,
        screenTransform: { ...original.screenTransform },
        camTransform: { ...original.camTransform },
      };
      const left: Scene = {
        ...original,
        end: atMs,
        screenTransform: { ...original.screenTransform },
        camTransform: { ...original.camTransform },
      };
      const next = [...p.scenes];
      next.splice(idx, 1, left, right);
      return { ...p, scenes: next };
    });
    setSelectedSceneId(null);
  }, []);

  /**
   * Remove a scene, merging its time range into the previous scene (or the
   * next if it's the first).
   */
  const deleteScene = useCallback((sceneId: string) => {
    setProject((p) => {
      if (!p) return p;
      if (p.scenes.length <= 1) return p; // can't delete the only scene
      const idx = p.scenes.findIndex((s) => s.id === sceneId);
      if (idx < 0) return p;
      const scene = p.scenes[idx];
      const next = [...p.scenes];
      if (idx > 0) {
        next[idx - 1] = { ...next[idx - 1], end: scene.end };
      } else {
        next[1] = { ...next[1], start: scene.start };
      }
      next.splice(idx, 1);
      return { ...p, scenes: next };
    });
    setSelectedSceneId(null);
  }, []);

  return {
    project,
    setProject,
    selectedScene,
    selectedSceneId,
    setSelectedSceneId,
    setCanvas,
    setSceneLayout,
    setSceneAudioSource,
    setSceneBubble,
    setSceneSecondarySource,
    updateSceneTransform,
    resetSceneTransform,
    splitAt,
    deleteScene,
  };
}

/**
 * Pick a sensible default layout given which tracks exist. Used when we
 * create the initial scene on project load.
 */
export function defaultLayout(
  tracks: { kind: TrackKind; hasVideo: boolean }[],
): Layout {
  const hasScreen = tracks.some((t) => t.kind === 'screen' && t.hasVideo);
  const hasCam = tracks.some((t) => t.kind === 'laptop-cam' && t.hasVideo);
  const hasMobile = tracks.some((t) => t.kind === 'mobile-cam' && t.hasVideo);
  if (hasScreen && (hasCam || hasMobile)) return 'screen-with-bubble';
  if (hasScreen) return 'screen-only';
  if (hasCam) return 'cam-only';
  if (hasMobile) return 'mobile-only';
  return 'screen-only';
}

/**
 * Default "second source" for split/bubble layouts. Prefers the laptop
 * cam (consistent with old behavior); falls back to phone when only the
 * phone provides a second video feed.
 */
export function defaultSecondarySource(
  tracks: { kind: TrackKind; hasVideo: boolean }[],
): SecondarySource {
  const hasCam = tracks.some((t) => t.kind === 'laptop-cam' && t.hasVideo);
  if (hasCam) return 'cam';
  const hasMobile = tracks.some((t) => t.kind === 'mobile-cam' && t.hasVideo);
  if (hasMobile) return 'mobile';
  return 'cam';
}

/**
 * Pick a default audio source. Prefer the laptop mic (dedicated audio
 * track), fall back to whatever track carries audio.
 */
export function defaultAudioSource(
  tracks: { kind: TrackKind; hasAudio: boolean }[],
): TrackKind | null {
  const mic = tracks.find((t) => t.kind === 'laptop-mic' && t.hasAudio);
  if (mic) return mic.kind;
  const any = tracks.find((t) => t.hasAudio);
  return any ? any.kind : null;
}

export function canvasFor(p: EditorProject): CanvasSize {
  return p.canvas;
}
