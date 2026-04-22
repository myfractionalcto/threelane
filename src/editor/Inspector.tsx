import type { TrackKind } from '@/platform';
import { cn } from '@/lib/utils';
import {
  Camera,
  Image as ImageIcon,
  Monitor,
  RotateCcw,
  Smartphone,
  SplitSquareHorizontal,
} from 'lucide-react';
import type {
  BubbleCorner,
  EditorProject,
  Layout,
  Orientation,
  Scene,
  SecondarySource,
  SourceRole,
  SourceTransform,
} from './types';

interface Props {
  project: EditorProject;
  scene: Scene | null;
  onLayoutChange: (l: Layout) => void;
  onAudioSourceChange: (t: TrackKind | null) => void;
  onBubbleChange: (c: BubbleCorner) => void;
  onSecondarySourceChange: (s: SecondarySource) => void;
  onCanvasChange: (o: Orientation) => void;
  onTransformChange: (role: SourceRole, patch: Partial<SourceTransform>) => void;
  onTransformReset: (role: SourceRole) => void;
}

/**
 * Right rail — project-level and scene-level settings.
 */
export function Inspector({
  project,
  scene,
  onLayoutChange,
  onAudioSourceChange,
  onBubbleChange,
  onSecondarySourceChange,
  onCanvasChange,
  onTransformChange,
  onTransformReset,
}: Props) {
  const hasScreen = project.tracks.some((t) => t.kind === 'screen');
  const hasCam = project.tracks.some((t) => t.kind === 'laptop-cam');
  const hasMobile = project.tracks.some((t) => t.kind === 'mobile-cam');
  // Split/bubble need screen + something else in the cam slot — the
  // something can be either the laptop webcam or the phone.
  const hasSecondary = hasCam || hasMobile;
  const audioTracks = project.tracks.filter((t) => t.hasAudio);

  // Which source roles are visible in the current layout — used to decide
  // which transform sections to show.
  const visibleRoles = (l: Layout): SourceRole[] => {
    switch (l) {
      case 'screen-only':
        return ['screen'];
      case 'cam-only':
      case 'mobile-only':
        return ['cam'];
      case 'split-horizontal':
      case 'screen-with-bubble':
        return ['screen', 'cam'];
    }
  };

  return (
    <aside className="w-80 shrink-0 border-l border-border/60 p-5 space-y-6 overflow-y-auto">
      <Section title="Canvas">
        <div className="grid grid-cols-3 gap-2">
          {(['portrait', 'landscape', 'square'] as const).map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => onCanvasChange(o)}
              className={cn(
                'px-2 py-2 text-xs rounded-md border capitalize',
                project.canvas.orientation === o
                  ? 'border-foreground/70 bg-foreground/10'
                  : 'border-border hover:border-foreground/40',
              )}
            >
              {o}
              <div className="text-[10px] text-muted-foreground font-mono mt-1">
                {aspectLabel(o)}
              </div>
            </button>
          ))}
        </div>
      </Section>

      {scene ? (
        <>
          <Section title="Scene layout">
            <div className="grid grid-cols-2 gap-2">
              <LayoutCard
                icon={<Monitor className="size-4" />}
                label="Screen"
                active={scene.layout === 'screen-only'}
                disabled={!hasScreen}
                onClick={() => onLayoutChange('screen-only')}
              />
              <LayoutCard
                icon={<Camera className="size-4" />}
                label="Camera"
                active={scene.layout === 'cam-only'}
                disabled={!hasCam}
                onClick={() => onLayoutChange('cam-only')}
              />
              <LayoutCard
                icon={<Smartphone className="size-4" />}
                label="Phone"
                active={scene.layout === 'mobile-only'}
                disabled={!hasMobile}
                onClick={() => onLayoutChange('mobile-only')}
              />
              <LayoutCard
                icon={<SplitSquareHorizontal className="size-4" />}
                label="Split"
                active={scene.layout === 'split-horizontal'}
                disabled={!hasScreen || !hasSecondary}
                onClick={() => onLayoutChange('split-horizontal')}
              />
              <LayoutCard
                icon={<ImageIcon className="size-4" />}
                label="Screen + bubble"
                active={scene.layout === 'screen-with-bubble'}
                disabled={!hasScreen || !hasSecondary}
                onClick={() => onLayoutChange('screen-with-bubble')}
              />
            </div>
          </Section>

          {(scene.layout === 'split-horizontal' ||
            scene.layout === 'screen-with-bubble') && (
            <Section title="Second source">
              <div className="grid grid-cols-2 gap-2">
                <SecondarySourceCard
                  icon={<Camera className="size-4" />}
                  label="Camera"
                  active={scene.secondarySource === 'cam'}
                  disabled={!hasCam}
                  onClick={() => onSecondarySourceChange('cam')}
                />
                <SecondarySourceCard
                  icon={<Smartphone className="size-4" />}
                  label="Phone"
                  active={scene.secondarySource === 'mobile'}
                  disabled={!hasMobile}
                  onClick={() => onSecondarySourceChange('mobile')}
                />
              </div>
            </Section>
          )}

          {scene.layout === 'screen-with-bubble' && (
            <Section title="Bubble corner">
              <div className="grid grid-cols-2 gap-2">
                {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onBubbleChange(c)}
                    className={cn(
                      'px-2 py-2 text-xs rounded-md border uppercase font-mono',
                      scene.bubbleCorner === c
                        ? 'border-foreground/70 bg-foreground/10'
                        : 'border-border hover:border-foreground/40',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </Section>
          )}

          {visibleRoles(scene.layout).map((role) => (
            <TransformSection
              key={role}
              role={role}
              transform={role === 'screen' ? scene.screenTransform : scene.camTransform}
              disabled={role === 'screen' ? !hasScreen : !hasCam}
              cursorTrackAvailable={role === 'screen' && !!project.cursorTrack}
              onChange={(patch) => onTransformChange(role, patch)}
              onReset={() => onTransformReset(role)}
            />
          ))}

          <Section title="Audio source">
            <div className="space-y-1.5">
              {audioTracks.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No audio tracks in this project.
                </div>
              )}
              {audioTracks.map((t) => (
                <label
                  key={t.id}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer text-sm',
                    scene.audioSource === t.kind
                      ? 'border-foreground/70 bg-foreground/10'
                      : 'border-border hover:border-foreground/40',
                  )}
                >
                  <input
                    type="radio"
                    name="audio"
                    className="sr-only"
                    checked={scene.audioSource === t.kind}
                    onChange={() => onAudioSourceChange(t.kind)}
                  />
                  {t.kind}
                </label>
              ))}
            </div>
          </Section>
        </>
      ) : (
        <div className="text-sm text-muted-foreground">
          Select a scene to edit its layout and audio.
        </div>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function LayoutCard({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex flex-col items-start gap-1.5 px-3 py-3 rounded-md border text-xs text-left transition',
        active
          ? 'border-foreground/70 bg-foreground/10'
          : 'border-border hover:border-foreground/40',
        'disabled:opacity-40 disabled:cursor-not-allowed',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Compact toggle for the secondary-source picker. Same visual idiom as
 * LayoutCard but centered / horizontal — we only ever have two options so
 * a full card grid would feel heavy.
 */
function SecondarySourceCard({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center justify-center gap-2 px-3 py-2 rounded-md border text-xs transition',
        active
          ? 'border-foreground/70 bg-foreground/10'
          : 'border-border hover:border-foreground/40',
        'disabled:opacity-40 disabled:cursor-not-allowed',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function aspectLabel(o: Orientation): string {
  switch (o) {
    case 'portrait':
      return '9:16';
    case 'landscape':
      return '16:9';
    case 'square':
      return '1:1';
  }
}

function TransformSection({
  role,
  transform,
  disabled,
  cursorTrackAvailable,
  onChange,
  onReset,
}: {
  role: SourceRole;
  transform: SourceTransform;
  disabled?: boolean;
  cursorTrackAvailable?: boolean;
  onChange: (patch: Partial<SourceTransform>) => void;
  onReset: () => void;
}) {
  const label = role === 'screen' ? 'Screen adjust' : 'Camera adjust';
  if (disabled) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <button
          type="button"
          onClick={onReset}
          title="Reset to defaults"
          className="text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>
      <div className="space-y-3">
        {/* Fit */}
        <div className="grid grid-cols-2 gap-1 p-1 rounded-md bg-secondary/60 border border-border">
          {(['contain', 'cover'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChange({ fit: mode })}
              className={cn(
                'px-2 py-1.5 text-xs rounded capitalize transition',
                transform.fit === mode
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {mode === 'contain' ? 'Fit' : 'Fill'}
            </button>
          ))}
        </div>

        <Slider
          label="Zoom"
          value={transform.zoom}
          min={0.5}
          max={3}
          step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => onChange({ zoom: v })}
        />
        <Slider
          label="X offset"
          value={transform.offsetX}
          min={-1}
          max={1}
          step={0.01}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          onChange={(v) => onChange({ offsetX: v })}
        />
        <Slider
          label="Y offset"
          value={transform.offsetY}
          min={-1}
          max={1}
          step={0.01}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          onChange={(v) => onChange({ offsetY: v })}
        />
        <p className="text-[11px] text-muted-foreground">
          Drag on the preview to pan this source.
        </p>

        {role === 'screen' && (
          <label
            className={cn(
              'flex items-start gap-2 px-3 py-2 rounded-md border cursor-pointer text-xs',
              transform.followCursor
                ? 'border-foreground/70 bg-foreground/10'
                : 'border-border hover:border-foreground/40',
              !cursorTrackAvailable && 'cursor-not-allowed opacity-60',
            )}
            title={
              cursorTrackAvailable
                ? 'Pan the zoomed view to follow the recorded mouse cursor.'
                : 'No cursor track — re-record in the desktop app to enable.'
            }
          >
            <input
              type="checkbox"
              className="mt-0.5"
              checked={transform.followCursor}
              disabled={!cursorTrackAvailable}
              onChange={(e) => onChange({ followCursor: e.target.checked })}
            />
            <span>
              <div className="font-medium text-foreground">Follow cursor</div>
              <div className="text-muted-foreground">
                {cursorTrackAvailable
                  ? 'Zoom in, then let the mouse lead the frame.'
                  : 'Desktop app only — web recordings can’t capture the cursor.'}
              </div>
            </span>
          </label>
        )}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1 accent-foreground bg-secondary rounded-full cursor-pointer"
      />
    </label>
  );
}
