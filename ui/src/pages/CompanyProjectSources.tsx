import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderCog, FolderOpen, LockKeyhole, RefreshCw, ServerCog, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";

type HostProjectSource = {
  id: string;
  name: string;
  sourcePath: string;
};

type HostProjectSourcesSnapshot = {
  privateTeamAccessEnabled: boolean;
  projects: HostProjectSource[];
};

type HostProjectSourcesBridge = {
  listHostProjectSources: () => Promise<HostProjectSourcesSnapshot>;
  chooseHostProjectSource: (input: { projectId: string }) => Promise<HostProjectSourcesSnapshot>;
  clearHostProjectSource: (input: { projectId: string }) => Promise<HostProjectSourcesSnapshot>;
  manageHostProjectSource: (input: { projectId: string }) => Promise<unknown>;
};

function getHostProjectSourcesBridge(): HostProjectSourcesBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { spsDesktopWorkspace?: Partial<HostProjectSourcesBridge> })
    .spsDesktopWorkspace;
  if (
    !candidate
    || typeof candidate.listHostProjectSources !== "function"
    || typeof candidate.chooseHostProjectSource !== "function"
    || typeof candidate.clearHostProjectSource !== "function"
    || typeof candidate.manageHostProjectSource !== "function"
  ) {
    return null;
  }
  return candidate as HostProjectSourcesBridge;
}

function messageFor(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function CompanyProjectSources() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const bridge = useMemo(() => getHostProjectSourcesBridge(), []);
  const [snapshot, setSnapshot] = useState<HostProjectSourcesSnapshot | null>(null);
  const [loading, setLoading] = useState(Boolean(bridge));
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Project Sources" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const reload = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await bridge.listHostProjectSources());
    } catch (caught) {
      setError(messageFor(caught, "Host project sources could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const chooseSource = async (projectId: string) => {
    if (!bridge || busyProjectId) return;
    setBusyProjectId(projectId);
    setError(null);
    setNotice(null);
    try {
      setSnapshot(await bridge.chooseHostProjectSource({ projectId }));
      setNotice("The source folder remains on this Owner Host. Members cannot replace it with a local folder.");
    } catch (caught) {
      setError(messageFor(caught, "The Host project source could not be updated."));
    } finally {
      setBusyProjectId(null);
    }
  };

  const clearSource = async (project: HostProjectSource) => {
    if (!bridge || busyProjectId) return;
    const confirmed = window.confirm(
      `Clear the Host source folder for \"${project.name}\"? Member source access must already be revoked.`,
    );
    if (!confirmed) return;
    setBusyProjectId(project.id);
    setError(null);
    setNotice(null);
    try {
      setSnapshot(await bridge.clearHostProjectSource({ projectId: project.id }));
      setNotice("This Project no longer has a Host source folder.");
    } catch (caught) {
      setError(messageFor(caught, "The Host project source could not be cleared."));
    } finally {
      setBusyProjectId(null);
    }
  };

  const manageMemberAccess = async (projectId: string) => {
    if (!bridge || busyProjectId) return;
    setBusyProjectId(projectId);
    setError(null);
    setNotice(null);
    try {
      await bridge.manageHostProjectSource({ projectId });
      await reload();
      setNotice("Member source access was reviewed on this Owner Host.");
    } catch (caught) {
      setError(messageFor(caught, "Member source access could not be updated."));
    } finally {
      setBusyProjectId(null);
    }
  };

  if (!bridge) {
    return (
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center gap-2">
          <FolderCog className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Project Sources</h1>
        </div>
        <Card className="py-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><LockKeyhole className="h-4 w-4" /> Host-managed source folders</CardTitle>
            <CardDescription>This computer cannot choose, replace, or store a Project source folder.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>Every Project source folder belongs to the Owner Host computer. When a Host grants this Member Node access, an approved Task can edit the Host files through a managed private connection.</p>
            <p>The folder is never copied to this computer and a Member cannot point the Project at another local folder.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const projects = snapshot?.projects ?? [];
  const canManageMemberAccess = snapshot?.privateTeamAccessEnabled === true;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <FolderCog className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Project Sources</h1>
          </div>
          <p className="text-sm text-muted-foreground">Select each Project's source folder on this Owner Host. A Member can work on the same files only after you grant that Node access.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void reload()} disabled={loading || busyProjectId !== null}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      <Card className="border-blue-500/30 bg-blue-500/5 py-0">
        <CardContent className="flex gap-3 py-4 text-sm text-muted-foreground">
          <ServerCog className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
          <p>The selected folder stays on this Host. SPS gives an approved Member only an encrypted, Host-managed connection for a permitted Task; the Member never selects a local Project folder.</p>
        </CardContent>
      </Card>

      {!canManageMemberAccess && !loading ? (
        <Card className="border-amber-500/30 bg-amber-500/5 py-0">
          <CardContent className="flex gap-3 py-4 text-sm text-muted-foreground">
            <UsersRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>Private team access is not enabled yet. You can select Host folders now, but enable private team access before granting a Member Node source access.</p>
          </CardContent>
        </Card>
      ) : null}

      {error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="rounded-md border border-emerald-600/30 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice}</p> : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading Host project sources...</p>
      ) : projects.length === 0 ? (
        <Card className="py-0"><CardContent className="py-8 text-sm text-muted-foreground">Create a Project first, then return here to choose its Host source folder.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => {
            const hasSource = Boolean(project.sourcePath);
            const busy = busyProjectId === project.id;
            return (
              <Card key={project.id} className="py-0">
                <CardHeader className="gap-3 py-4">
                  <div className="space-y-1">
                    <CardTitle className="text-base">{project.name}</CardTitle>
                    <CardDescription className="break-all font-mono text-xs">{hasSource ? project.sourcePath : "No source folder selected on this Owner Host."}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2 pb-4">
                  <Button type="button" size="sm" onClick={() => void chooseSource(project.id)} disabled={busy}>
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" /> {hasSource ? "Change Host folder" : "Choose Host folder"}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void manageMemberAccess(project.id)} disabled={!hasSource || !canManageMemberAccess || busy}>
                    <UsersRound className="mr-1.5 h-3.5 w-3.5" /> Manage Member access
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void clearSource(project)} disabled={!hasSource || busy}>Clear</Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
