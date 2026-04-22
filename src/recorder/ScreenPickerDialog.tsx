import { useEffect, useMemo, useState } from 'react';
import { AppWindow, Loader2, Monitor, X } from 'lucide-react';
import { platform } from '@/platform';
import type { ScreenSource } from '@/platform';
import { cn } from '@/lib/utils';

interface Props {
  /** Highlight this id if it's still in the list. */
  selectedId: string;
  onPick: (sourceId: string) => void;
  onClose: () => void;
}

type Tab = 'screen' | 'window';

/**
 * Chrome-style screen picker: two tabs (Entire Screen / Window) over a grid
 * of live thumbnails. We poll `desktopCapturer.getSources` at ~1 Hz so the
 * previews stay roughly in sync with what's on screen — Electron returns
 * snapshots, not a live stream, so this is the best we can do without
 * opening a throwaway MediaStream per tile.
 *
 * The web platform can't enumerate screens (browsers show their own native
 * picker via `getDisplayMedia`), so this component is Electron-only.
 */
export function ScreenPickerDialog({ selectedId, onPick, onClose }: Props) {
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('screen');

  // Close on Escape, and lock body scroll while the modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Poll for fresh thumbnails. 1s cadence is a good trade-off between
  // CPU/IPC cost and the preview feeling "live" — Electron's getSources
  // re-grabs a full frame of every display each call.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await platform.listScreenSources();
        if (!cancelled) {
          setSources(list);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const id = setInterval(load, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Electron source ids look like `screen:0:0` and `window:1234:0`.
  // That prefix is the one reliable signal for tab routing.
  const { screens, windows } = useMemo(() => {
    const s: ScreenSource[] = [];
    const w: ScreenSource[] = [];
    for (const src of sources) {
      if (src.id.startsWith('screen:')) s.push(src);
      else w.push(src);
    }
    return { screens: s, windows: w };
  }, [sources]);

  const visible = tab === 'screen' ? screens : windows;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6"
      onMouseDown={(e) => {
        // Click on the backdrop closes. Click inside the card is stopped
        // by the inner onMouseDown.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-4xl h-[80vh] flex flex-col rounded-xl bg-card border border-border shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header + tabs */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border/60 shrink-0">
          <div className="font-medium">Choose what to record</div>
          <div className="ml-4 flex items-center gap-1 p-1 rounded-lg bg-secondary/40">
            <TabButton
              icon={<Monitor className="size-4" />}
              label={`Entire Screen${screens.length ? ` · ${screens.length}` : ''}`}
              active={tab === 'screen'}
              onClick={() => setTab('screen')}
            />
            <TabButton
              icon={<AppWindow className="size-4" />}
              label={`Window${windows.length ? ` · ${windows.length}` : ''}`}
              active={tab === 'window'}
              onClick={() => setTab('window')}
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Grid */}
        <div className="flex-1 min-h-0 overflow-y-auto p-5">
          {loading && (
            <div className="h-full flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading sources…
            </div>
          )}
          {!loading && visible.length === 0 && (
            <EmptyState tab={tab} />
          )}
          {!loading && visible.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {visible.map((src) => (
                <SourceTile
                  key={src.id}
                  src={src}
                  selected={src.id === selectedId}
                  onClick={() => onPick(src.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function SourceTile({
  src,
  selected,
  onClick,
}: {
  src: ScreenSource;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex flex-col rounded-lg overflow-hidden border bg-black/40 text-left transition',
        selected
          ? 'border-primary ring-2 ring-primary/40'
          : 'border-border hover:border-foreground/40',
      )}
    >
      <div className="relative aspect-video w-full bg-black flex items-center justify-center">
        {src.thumbnailDataUrl ? (
          <img
            src={src.thumbnailDataUrl}
            alt={src.name}
            className="w-full h-full object-contain"
          />
        ) : (
          <Monitor className="size-6 text-muted-foreground" />
        )}
      </div>
      <div className="px-3 py-2 text-xs font-medium truncate">{src.name}</div>
    </button>
  );
}

function EmptyState({ tab }: { tab: Tab }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-sm text-muted-foreground">
      {tab === 'screen' ? (
        <>
          <Monitor className="size-6" />
          <div>No screens detected.</div>
          <div className="text-xs">
            macOS needs Screen Recording permission for Threelane.
            Open System Settings → Privacy &amp; Security → Screen Recording,
            enable it, then fully quit and relaunch the app.
          </div>
        </>
      ) : (
        <>
          <AppWindow className="size-6" />
          <div>No windows detected.</div>
          <div className="text-xs">
            Same permission as above — once granted, open windows will appear here.
          </div>
        </>
      )}
    </div>
  );
}
