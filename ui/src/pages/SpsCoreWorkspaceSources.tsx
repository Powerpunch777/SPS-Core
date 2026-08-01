import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderCog, FolderOpen, FolderPlus, LockKeyhole, Pencil, RefreshCw, Trash2, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";

type WorkspaceSource = {
  id: string;
  name: string;
  sourcePath: string;
  routeStatus?: "ready" | "unavailable";
  memberNodes?: Array<{ id: string; sourceAccess: "granted" | "not_granted" }>;
};
type WorkspaceSourcesSnapshot = { privateTeamAccessEnabled: boolean; sources: WorkspaceSource[] };
type WorkspaceSourcesBridge = {
  listHostWorkspaceSources: () => Promise<WorkspaceSourcesSnapshot>;
  chooseHostWorkspaceSource: () => Promise<WorkspaceSourcesSnapshot>;
  renameHostWorkspaceSource: (input: { sourceId: string; name: string }) => Promise<WorkspaceSourcesSnapshot>;
  removeHostWorkspaceSource: (input: { sourceId: string }) => Promise<WorkspaceSourcesSnapshot>;
  manageHostWorkspaceSource: (input: { sourceId: string }) => Promise<unknown>;
};

function getWorkspaceSourcesBridge(): WorkspaceSourcesBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { spsDesktopWorkspace?: Partial<WorkspaceSourcesBridge> }).spsDesktopWorkspace;
  if (!candidate || typeof candidate.listHostWorkspaceSources !== "function" || typeof candidate.chooseHostWorkspaceSource !== "function" || typeof candidate.renameHostWorkspaceSource !== "function" || typeof candidate.removeHostWorkspaceSource !== "function" || typeof candidate.manageHostWorkspaceSource !== "function") return null;
  return candidate as WorkspaceSourcesBridge;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SpsCoreWorkspaceSources() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const bridge = useMemo(() => getWorkspaceSourcesBridge(), []);
  const [snapshot, setSnapshot] = useState<WorkspaceSourcesSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(Boolean(bridge));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Workspace", href: "/dashboard" },
      { label: "Host settings", href: "/company/settings" },
      { label: "Sources" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const applySnapshot = (next: WorkspaceSourcesSnapshot) => {
    setSnapshot(next);
    setDrafts(Object.fromEntries(next.sources.map((source) => [source.id, source.name])));
  };
  const reload = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    setError(null);
    try { applySnapshot(await bridge.listHostWorkspaceSources()); }
    catch (caught) { setError(errorMessage(caught, "Workspace sources could not be loaded.")); }
    finally { setLoading(false); }
  }, [bridge]);
  useEffect(() => { void reload(); }, [reload]);

  const addSource = async () => {
    if (!bridge || busy) return;
    setBusy("add"); setError(null); setNotice(null);
    try {
      applySnapshot(await bridge.chooseHostWorkspaceSource());
      setNotice("Source folder registered on this SPS Host.");
    } catch (caught) { setError(errorMessage(caught, "The Host source folder could not be registered.")); }
    finally { setBusy(null); }
  };
  const renameSource = async (source: WorkspaceSource) => {
    if (!bridge || busy) return;
    const name = (drafts[source.id] ?? source.name).trim();
    if (!name || name === source.name) return;
    setBusy(source.id); setError(null); setNotice(null);
    try {
      applySnapshot(await bridge.renameHostWorkspaceSource({ sourceId: source.id, name }));
      setNotice("Source name updated.");
    } catch (caught) { setError(errorMessage(caught, "The source name could not be updated.")); }
    finally { setBusy(null); }
  };
  const removeSource = async (source: WorkspaceSource) => {
    if (!bridge || busy) return;
    const folderNotice = source.sourcePath
      ? `This keeps every file in ${source.sourcePath}.`
      : "No local folder is mapped to this Source on the current Host.";
    if (!window.confirm(`Remove the SPS source "${source.name}"? ${folderNotice}`)) return;
    setBusy(source.id); setError(null); setNotice(null);
    try {
      applySnapshot(await bridge.removeHostWorkspaceSource({ sourceId: source.id }));
      setNotice("Source removed from SPS. No external files were deleted.");
    } catch (caught) { setError(errorMessage(caught, "The source could not be removed.")); }
    finally { setBusy(null); }
  };
  const manageMemberAccess = async (source: WorkspaceSource) => {
    if (!bridge || busy) return;
    setBusy(source.id); setError(null); setNotice(null);
    try {
      await bridge.manageHostWorkspaceSource({ sourceId: source.id });
      await reload();
      setNotice("Member Source access updated.");
    } catch (caught) { setError(errorMessage(caught, "Member Source access could not be updated.")); }
    finally { setBusy(null); }
  };

  if (!bridge) return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-2"><FolderCog className="h-5 w-5 text-muted-foreground" /><h1 className="text-lg font-semibold">Sources</h1></div>
      <Card className="py-0">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><LockKeyhole className="h-4 w-4" />Host-managed source folders</CardTitle><CardDescription>Only the SPS Host can choose folders for this Workspace.</CardDescription></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground"><p>Source paths remain on the Host. Plugins receive only a selected source handle and must request any execution route through Core.</p><p>This Member computer cannot substitute a local folder.</p></CardContent>
      </Card>
    </div>
  );

  const sources = snapshot?.sources ?? [];
  return (
    <div className="max-w-4xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1"><div className="flex items-center gap-2"><FolderCog className="h-5 w-5 text-muted-foreground" /><h1 className="text-lg font-semibold">Sources</h1></div><p className="max-w-2xl text-sm text-muted-foreground">Register named folders that stay on this SPS Host. Plugins can use a source only when a user selects it in that plugin's workflow.</p></div>
        <div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => void reload()} disabled={loading || busy !== null}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh</Button><Button type="button" size="sm" onClick={() => void addSource()} disabled={busy !== null}><FolderPlus className="mr-1.5 h-3.5 w-3.5" />Add folder</Button></div>
      </header>
      <Card className="border-blue-500/30 bg-blue-500/5 py-0"><CardContent className="py-4 text-sm text-muted-foreground">SPS stores this registration on the Host only. Removing it removes the SPS handle, never the folder or its files.</CardContent></Card>
      {error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="rounded-md border border-emerald-600/30 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading Host sources...</p> : null}
      {!loading && sources.length === 0 ? <Card className="py-0"><CardContent className="py-8 text-sm text-muted-foreground">No source folders have been registered for this Workspace.</CardContent></Card> : null}
      <div className="space-y-3">{sources.map((source) => {
        const pendingName = (drafts[source.id] ?? source.name).trim();
        const folderLabel = source.sourcePath || "No local folder mapping on this Host";
        const grantedCount = (source.memberNodes ?? []).filter((node) => node.sourceAccess === "granted").length;
        return <Card key={source.id} className="py-0"><CardHeader className="gap-3 py-4"><div className="flex flex-wrap items-center gap-2"><Input aria-label={`${source.name} source name`} className="h-8 max-w-xs" value={drafts[source.id] ?? source.name} onChange={(event) => setDrafts((current) => ({ ...current, [source.id]: event.target.value }))} disabled={busy !== null} /><Button type="button" variant="outline" size="sm" onClick={() => void renameSource(source)} disabled={busy !== null || !pendingName || pendingName === source.name}><Pencil className="mr-1.5 h-3.5 w-3.5" />Rename</Button></div><CardDescription className="flex items-start gap-2 break-all font-mono text-xs"><FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />{folderLabel}</CardDescription></CardHeader><CardContent className="flex flex-wrap items-center justify-between gap-2 pb-4"><Button type="button" variant="outline" size="sm" onClick={() => void manageMemberAccess(source)} disabled={busy !== null || !snapshot?.privateTeamAccessEnabled}><UsersRound className="mr-1.5 h-3.5 w-3.5" />Member access{grantedCount > 0 ? ` (${grantedCount})` : ""}</Button><Button type="button" variant="ghost" size="sm" onClick={() => void removeSource(source)} disabled={busy !== null}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Remove from SPS</Button></CardContent></Card>;
      })}</div>
    </div>
  );
}
