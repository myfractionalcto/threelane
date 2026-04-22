import { useEffect, useState } from 'react';
import { FolderOpen, Loader2, Trash2, X } from 'lucide-react';
import { platform } from '@/platform';

interface Props {
  onClose: () => void;
  onOpen: (projectId: string | null) => void;
}

/**
 * Lists previously recorded projects on Electron; on the web the picker
 * is just a hint that triggers the file-upload dialog immediately.
 */
export function OpenProjectDialog({ onClose, onOpen }: Props) {
  const [projects, setProjects] = useState<
    { id: string; name?: string; location: string; createdAtMs: number }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    platform
      .listProjects()
      .then((ps) => {
        setProjects(ps);
        setLoading(false);
        // On web, no projects are listed — jump straight to the file picker.
        if (platform.kind === 'web') onOpen(null);
      })
      .catch(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-xl bg-card border border-border shadow-xl">
        <div className="flex items-center gap-3 p-5 border-b border-border/60">
          <FolderOpen className="size-5" />
          <div className="font-medium">Open project</div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="p-2 max-h-80 overflow-y-auto">
          {loading && (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {!loading && projects.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground">
              No saved projects yet. Record one first from the Home screen.
            </div>
          )}
          {projects.map((p) => (
            <div
              key={p.id}
              className="group flex items-stretch rounded-md hover:bg-secondary/60"
            >
              <button
                type="button"
                onClick={() => onOpen(p.id)}
                className="flex-1 min-w-0 text-left px-4 py-3 flex flex-col gap-0.5"
              >
                <span className="text-sm font-medium">{p.name || p.id}</span>
                <span className="text-xs text-muted-foreground font-mono truncate">
                  {p.location}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(p.createdAtMs).toLocaleString()}
                </span>
              </button>
              <button
                type="button"
                aria-label="Delete project"
                title="Delete project"
                onClick={async () => {
                  const ok = window.confirm(
                    `Delete "${p.name || p.id}" and all its recording files?\n\nThis can't be undone.`,
                  );
                  if (!ok) return;
                  try {
                    await platform.deleteProject(p.id);
                    setProjects((cur) => cur.filter((x) => x.id !== p.id));
                  } catch (e) {
                    console.error(e);
                    alert(`Failed to delete project: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
                className="px-3 text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100 transition"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
