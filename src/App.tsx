import { useCallback, useEffect, useState } from 'react';
import { Clock, FolderOpen, Trash2, Video } from 'lucide-react';
import { cn } from '@/lib/utils';
import { platform } from '@/platform';
import { RecorderView } from '@/recorder/RecorderView';
import { EditorView } from '@/editor/EditorView';
import { OpenProjectDialog } from '@/editor/OpenProjectDialog';

type View =
  | { kind: 'home' }
  | { kind: 'recorder' }
  | { kind: 'editor'; projectId: string | null };

interface ProjectListing {
  id: string;
  name?: string;
  location: string;
  createdAtMs: number;
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'home' });
  const [openPickerVisible, setOpenPickerVisible] = useState(false);
  const [projects, setProjects] = useState<ProjectListing[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  const refreshProjects = useCallback(() => {
    platform
      .listProjects()
      .then((ps) => {
        setProjects(ps);
        setProjectsLoaded(true);
      })
      .catch(() => setProjectsLoaded(true));
  }, []);

  // Refresh whenever we land back on the home view — covers fresh recordings,
  // deletes from the open dialog, and project edits that change names.
  useEffect(() => {
    if (view.kind !== 'home') return;
    refreshProjects();
  }, [view.kind, refreshProjects]);

  if (view.kind === 'recorder') {
    return (
      <RecorderView
        onExit={() => setView({ kind: 'home' })}
        onOpenInEditor={(projectId) =>
          setView({ kind: 'editor', projectId })
        }
      />
    );
  }

  if (view.kind === 'editor') {
    return (
      <EditorView
        projectId={view.projectId}
        onExit={() => setView({ kind: 'home' })}
      />
    );
  }

  const showRecent = platform.kind === 'electron';

  return (
    <main className="min-h-screen flex flex-col">
      <header
        className={cn(
          'py-6 flex items-center gap-3 border-b border-border/50',
          platform.kind === 'electron' ? 'pl-[84px] pr-8' : 'px-8',
        )}
      >
        <img src="./favicon.svg" alt="Threelane" className="size-8 rounded-lg" />
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Threelane</h1>
          <p className="text-xs text-muted-foreground">
            Local recorder & reels editor
          </p>
        </div>
        <div className="ml-auto text-xs text-muted-foreground font-mono">
          v0.1.0 · {platform.kind === 'electron' ? 'desktop' : 'browser'}
        </div>
      </header>

      <section className="flex-1 px-8 py-12">
        <div className="max-w-2xl w-full mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-4xl font-semibold tracking-tight mb-3">
              Start a new project
            </h2>
            <p className="text-muted-foreground">
              Record your screen, webcam, and phone — then cut it into a reel.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <HomeCard
              icon={<Video className="size-6" />}
              title="New recording"
              description="Pick inputs, connect a phone, hit record."
              onClick={() => setView({ kind: 'recorder' })}
            />
            <HomeCard
              icon={<FolderOpen className="size-6" />}
              title="Open project"
              description={
                platform.kind === 'electron'
                  ? 'Resume a recording from ~/Movies/Threelane.'
                  : 'Upload a manifest and its track files.'
              }
              onClick={() => setOpenPickerVisible(true)}
            />
          </div>

          {showRecent && (
            <RecentProjects
              projects={projects}
              loaded={projectsLoaded}
              onOpen={(id) => setView({ kind: 'editor', projectId: id })}
              onDeleted={(id) =>
                setProjects((cur) => cur.filter((p) => p.id !== id))
              }
              onSeeAll={() => setOpenPickerVisible(true)}
            />
          )}

          <p className="text-center text-xs text-muted-foreground mt-10">
            {platform.kind === 'web'
              ? 'Web mode — recordings download to your browser.'
              : 'Recordings save to ~/Movies/Threelane/.'}
          </p>
        </div>
      </section>

      {openPickerVisible && (
        <OpenProjectDialog
          onClose={() => setOpenPickerVisible(false)}
          onOpen={(projectId) => {
            setOpenPickerVisible(false);
            setView({ kind: 'editor', projectId });
          }}
        />
      )}
    </main>
  );
}

function HomeCard({
  icon,
  title,
  description,
  disabled,
  disabledHint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
  disabledHint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'group relative text-left rounded-xl border border-border bg-card p-6 transition',
        'hover:border-foreground/30 hover:bg-card/80',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-card',
      )}
    >
      <div className="size-10 rounded-lg bg-secondary flex items-center justify-center mb-4">
        {icon}
      </div>
      <div className="font-medium mb-1">{title}</div>
      <div className="text-sm text-muted-foreground">{description}</div>
      {disabled && disabledHint && (
        <span className="absolute top-4 right-4 text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
          {disabledHint}
        </span>
      )}
    </button>
  );
}

const RECENT_LIMIT = 3;

function RecentProjects({
  projects,
  loaded,
  onOpen,
  onDeleted,
  onSeeAll,
}: {
  projects: ProjectListing[];
  loaded: boolean;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
  onSeeAll: () => void;
}) {
  if (!loaded || projects.length === 0) return null;
  const recent = projects.slice(0, RECENT_LIMIT);
  const hasMore = projects.length > RECENT_LIMIT;

  return (
    <div className="mt-12">
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <Clock className="size-3" />
          Recent
        </div>
        {hasMore && (
          <button
            type="button"
            onClick={onSeeAll}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            See all
          </button>
        )}
      </div>
      <div>
        {recent.map((p) => (
          <RecentRow key={p.id} project={p} onOpen={onOpen} onDeleted={onDeleted} />
        ))}
      </div>
    </div>
  );
}

function RecentRow({
  project,
  onOpen,
  onDeleted,
}: {
  project: ProjectListing;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = window.confirm(
      `Delete "${project.name || project.id}" and all its recording files?\n\nThis can't be undone.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await platform.deleteProject(project.id);
      onDeleted(project.id);
    } catch (err) {
      console.error(err);
      alert(`Failed to delete project: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  };

  return (
    <div className="group flex items-center rounded-md hover:bg-secondary/40 transition">
      <button
        type="button"
        onClick={() => onOpen(project.id)}
        disabled={busy}
        className="flex-1 min-w-0 text-left px-3 py-2 disabled:opacity-50"
      >
        <span className="text-sm truncate block">
          {project.name || project.id}
        </span>
      </button>
      <div className="flex items-center gap-1 pr-1">
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
          {formatRelative(project.createdAtMs)}
        </span>
        <button
          type="button"
          aria-label="Delete project"
          title="Delete project"
          onClick={handleDelete}
          disabled={busy}
          className="p-2 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition disabled:opacity-50"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  );
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ms).toLocaleDateString();
}
