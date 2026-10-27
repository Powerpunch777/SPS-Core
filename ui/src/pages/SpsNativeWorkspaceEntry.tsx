import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SpsEmptyWorkspace } from "./SpsEmptyWorkspace";
import type {
  NativeWorkspaceBootstrap,
  NativeWorkspaceSurface,
  SpsNativeWorkspaceBridge,
} from "../native-workspace-bridge";

type View = "workspace" | "dashboard" | "inbox";
type DashboardRow = Readonly<{ pluginId: string; widgetId: string; title: string; description: string }>;
type InboxRow = Readonly<{
  id: string;
  title: string;
  summary: string;
  severity: string;
  unread: boolean;
  archived: boolean;
}>;
type SurfaceModel =
  | Readonly<{ kind: "shell-neutral"; selectionUnavailable: boolean }>
  | Readonly<{ kind: "shell-plugin-unavailable"; pluginId: string | null; shellId: string | null }>
  | Readonly<{ kind: "dashboard"; rows: readonly DashboardRow[] }>
  | Readonly<{ kind: "inbox"; rows: readonly InboxRow[] }>;

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const CAPABILITIES = [
  "workspace.shell.read",
  "workspace.dashboard.read",
  "workspace.inbox.read",
] as const;
const INBOX_WRITE = "workspace.inbox.state.write";
const UNAVAILABLE = "Workspace could not be loaded.";

function plainDataRecord(
  value: unknown,
  allowedKeys?: readonly string[],
  requiredKeys: readonly string[] = allowedKeys ?? [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(UNAVAILABLE);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(UNAVAILABLE);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some(key => typeof key !== "string" || (allowedKeys && !allowedKeys.includes(key)))) {
    throw new Error(UNAVAILABLE);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of actual as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error(UNAVAILABLE);
    result[key] = descriptor.value;
  }
  if (requiredKeys.some(key => !Object.hasOwn(result, key))) throw new Error(UNAVAILABLE);
  return result;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseCapabilities(value: unknown): NativeWorkspaceBootstrap["capabilities"] | null {
  if (!Array.isArray(value) || (value.length !== CAPABILITIES.length && value.length !== CAPABILITIES.length + 1)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = [...Array.from({ length: value.length }, (_, index) => String(index)), "length"];
  const actualKeys = Reflect.ownKeys(descriptors);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some(key => typeof key !== "string" || !expectedKeys.includes(key))) return null;
  const parsed: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") return null;
    parsed.push(descriptor.value);
  }
  if (parsed.some((capability, index) => capability !== (CAPABILITIES[index] ?? (index === CAPABILITIES.length ? INBOX_WRITE : undefined)))) return null;
  return Object.freeze(parsed) as NativeWorkspaceBootstrap["capabilities"];
}

export function parseNativeWorkspaceBootstrap(value: unknown): NativeWorkspaceBootstrap {
  const root = plainDataRecord(value, ["v", "kind", "workspace", "member", "capabilities"]);
  const workspace = plainDataRecord(root.workspace, ["id", "name", "issuePrefix"]);
  const member = plainDataRecord(root.member, ["userId"]);
  const capabilities = parseCapabilities(root.capabilities);
  if (root.v !== 1 || root.kind !== "sps.native.workspace.bootstrap"
    || typeof workspace.id !== "string" || !UUID.test(workspace.id)
    || !nonemptyString(workspace.name) || !nonemptyString(workspace.issuePrefix)
    || !nonemptyString(member.userId)
    || !capabilities) {
    throw new Error(UNAVAILABLE);
  }
  return Object.freeze({
    v: 1 as const,
    kind: "sps.native.workspace.bootstrap" as const,
    workspace: Object.freeze({
      id: workspace.id as string,
      name: workspace.name,
      issuePrefix: workspace.issuePrefix,
    }),
    member: Object.freeze({ userId: member.userId }),
    capabilities,
  });
}

function readSurfaceRequest(view: View, archived = false): Readonly<{ surface: NativeWorkspaceSurface; archived?: boolean }> {
  if (view === "workspace") return Object.freeze({ surface: "shell" });
  if (view === "dashboard") return Object.freeze({ surface: "dashboard" });
  return Object.freeze({ surface: "inbox", archived });
}

function parseSurface(view: View, value: unknown, workspaceId: string): SurfaceModel {
  if (view === "workspace") {
    const shell = plainDataRecord(value, ["mode", "providerPluginId", "providerPluginKey", "shell", "fallbackReason"]);
    if (shell.mode === "neutral") {
      return Object.freeze({ kind: "shell-neutral", selectionUnavailable: nonemptyString(shell.fallbackReason) });
    }
    if (shell.mode === "plugin") {
      const declaration = shell.shell && typeof shell.shell === "object" ? plainDataRecord(shell.shell) : null;
      return Object.freeze({ kind: "shell-plugin-unavailable",
        pluginId: typeof shell.providerPluginId === "string" ? shell.providerPluginId : null,
        shellId: declaration && typeof declaration.id === "string" ? declaration.id : null });
    }
    throw new Error(UNAVAILABLE);
  }

  if (view === "dashboard") {
    const dashboard = plainDataRecord(value, ["widgets"]);
    if (!Array.isArray(dashboard.widgets)) throw new Error(UNAVAILABLE);
    const rows = dashboard.widgets.map(entry => {
      const widgetRecord = plainDataRecord(entry);
      const widget = plainDataRecord(widgetRecord.widget);
      if (!nonemptyString(widget.displayName)
        || (widget.description !== undefined && typeof widget.description !== "string")) throw new Error(UNAVAILABLE);
      if (!nonemptyString(widgetRecord.pluginId) || !nonemptyString(widget.id)) throw new Error(UNAVAILABLE);
      return Object.freeze({ pluginId: widgetRecord.pluginId, widgetId: widget.id, title: widget.displayName,
        description: typeof widget.description === "string" ? widget.description : "" });
    });
    return Object.freeze({ kind: "dashboard", rows: Object.freeze(rows) });
  }

  const inbox = plainDataRecord(value, ["items"]);
  if (!Array.isArray(inbox.items)) throw new Error(UNAVAILABLE);
  const rows = inbox.items.map(entry => {
    const item = plainDataRecord(entry);
    if (!nonemptyString(item.title) || typeof item.summary !== "string"
      || typeof item.severity !== "string"
      || !["info", "success", "warning", "error"].includes(item.severity)
      || typeof item.id !== "string" || !UUID.test(item.id)
      || item.companyId !== workspaceId || typeof item.unread !== "boolean"
      || (item.readAt !== null && typeof item.readAt !== "string")
      || (item.archivedAt !== null && typeof item.archivedAt !== "string")) throw new Error(UNAVAILABLE);
    return Object.freeze({ id: item.id, title: item.title, summary: item.summary, severity: item.severity,
      unread: item.unread, archived: item.archivedAt !== null });
  });
  return Object.freeze({ kind: "inbox", rows: Object.freeze(rows) });
}

function SurfaceContent({ model, workspaceName, canWriteInbox = false, updatingItemId = null, onUpdateInbox, onToggleArchived, onOpenPlugin, openingSurfaceId, archived = false }: {
  model: SurfaceModel;
  workspaceName: string;
  canWriteInbox?: boolean;
  updatingItemId?: string | null;
  onUpdateInbox?: (item: InboxRow, change: "read" | "archived") => void;
  onToggleArchived?: () => void;
  onOpenPlugin?: (pluginId: string, surface: "shell" | "widget", surfaceId: string) => void;
  openingSurfaceId?: string | null;
  archived?: boolean;
}) {
  if (model.kind === "shell-neutral") {
    return <SpsEmptyWorkspace workspaceName={workspaceName} selectionUnavailable={model.selectionUnavailable} />;
  }
  if (model.kind === "shell-plugin-unavailable") {
    return (
      <main className="min-h-dvh w-full bg-background px-6 py-12 text-foreground">
        <section className="mx-auto w-full max-w-2xl space-y-3">
          <h1 className="text-2xl font-semibold">{workspaceName}</h1>
          <p role="status" className="text-sm text-muted-foreground">
            This Workspace has a selected Plugin Shell. Its declared Plugin view runs in an isolated Native window.
          </p>
          {model.pluginId && model.shellId ? <Button type="button" disabled={!onOpenPlugin || openingSurfaceId !== null}
            onClick={() => onOpenPlugin?.(model.pluginId!, "shell", model.shellId!)}>
            {openingSurfaceId === model.shellId ? "Opening..." : "Open Plugin view"}
          </Button> : null}
        </section>
      </main>
    );
  }
  if (model.kind === "dashboard") {
    return (
      <section aria-labelledby="native-dashboard-title" className="mx-auto w-full max-w-5xl space-y-4">
        <h2 id="native-dashboard-title" className="text-2xl font-semibold">Dashboard</h2>
        {model.rows.length === 0 ? <p className="text-sm text-muted-foreground">No dashboard content is available.</p> : (
          <>
            <p className="text-sm text-muted-foreground">
              These widgets are configured for this Workspace and open in isolated Native Plugin windows.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {model.rows.map((row) => (
                <Card key={`${row.pluginId}:${row.widgetId}`}>
                  <CardHeader><CardTitle>{row.title}</CardTitle></CardHeader>
                  {row.description ? <CardContent>{row.description}</CardContent> : null}
                  <CardContent><Button type="button" variant="outline" disabled={!onOpenPlugin || openingSurfaceId !== null}
                    onClick={() => onOpenPlugin?.(row.pluginId, "widget", row.widgetId)}>
                    {openingSurfaceId === row.widgetId ? "Opening..." : "Open Plugin view"}
                  </Button></CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </section>
    );
  }
  return (
    <section aria-labelledby="native-inbox-title" className="mx-auto w-full max-w-5xl space-y-4">
      <h2 id="native-inbox-title" className="text-2xl font-semibold">Inbox</h2>
      <Button type="button" variant="outline" onClick={onToggleArchived} disabled={!onToggleArchived}>
        {archived ? "Show active" : "Show archived"}
      </Button>
      {model.rows.length === 0 ? <p className="text-sm text-muted-foreground">No inbox items.</p> : (
        <div className="space-y-3">
          {model.rows.map((row) => (
            <Card key={row.id}>
              <CardHeader>
                <CardTitle>{row.title}</CardTitle>
                <p className="text-xs text-muted-foreground">{row.severity}</p>
                <p className="text-xs text-muted-foreground">{row.unread ? "Unread" : "Read"}{row.archived ? " · Archived" : ""}</p>
              </CardHeader>
              {row.summary ? <CardContent>{row.summary}</CardContent> : null}
              {canWriteInbox ? (
                <CardContent className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" disabled={updatingItemId !== null}
                    onClick={() => onUpdateInbox?.(row, "read")}>
                    {updatingItemId === row.id ? "Updating..." : row.unread ? "Mark read" : "Mark unread"}
                  </Button>
                  <Button type="button" variant="outline" disabled={updatingItemId !== null}
                    onClick={() => onUpdateInbox?.(row, "archived")}>
                    {updatingItemId === row.id ? "Updating..." : row.archived ? "Restore" : "Archive"}
                  </Button>
                </CardContent>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

export function SpsNativeWorkspaceEntry({ bridge }: { bridge: SpsNativeWorkspaceBridge }) {
  const generation = useRef(0);
  const [bootstrap, setBootstrap] = useState<NativeWorkspaceBootstrap | null>(null);
  const [view, setView] = useState<View>("workspace");
  const [surface, setSurface] = useState<SurfaceModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [archived, setArchived] = useState(false);
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null);
  const [openingSurfaceId, setOpeningSurfaceId] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);

  const load = useCallback(async (nextView: View, nextArchived = false) => {
    const current = ++generation.current;
    setBootstrap(null);
    setSurface(null);
    setView(nextView);
    setFailed(false);
    setArchived(nextView === "inbox" ? nextArchived : false);
    setUpdatingItemId(null);
    setLoading(true);
    try {
      const nextBootstrap = parseNativeWorkspaceBootstrap(await bridge.getBootstrap());
      if (current !== generation.current) return;
      setBootstrap(nextBootstrap);
      const nextSurface = parseSurface(nextView, await bridge.readSurface(readSurfaceRequest(nextView, nextArchived)), nextBootstrap.workspace.id);
      if (current !== generation.current) return;
      setSurface(nextSurface);
    } catch {
      if (current === generation.current) {
        setBootstrap(null);
        setSurface(null);
        setFailed(true);
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [bridge]);

  const changeView = useCallback(async (nextView: View, nextArchived = false) => {
    if (!bootstrap) return;
    const current = ++generation.current;
    setView(nextView);
    setSurface(null);
    setFailed(false);
    setArchived(nextView === "inbox" ? nextArchived : false);
    setUpdatingItemId(null);
    setLoading(true);
    try {
      const nextSurface = parseSurface(nextView, await bridge.readSurface(readSurfaceRequest(nextView, nextArchived)), bootstrap.workspace.id);
      if (current !== generation.current) return;
      setSurface(nextSurface);
    } catch {
      if (current === generation.current) {
        setBootstrap(null);
        setSurface(null);
        setFailed(true);
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [bootstrap, bridge]);

  const toggleArchived = useCallback(() => {
    if (view !== "inbox" || !bootstrap) return;
    const nextArchived = !archived;
    setArchived(nextArchived);
    void changeView("inbox", nextArchived);
  }, [archived, bootstrap, changeView, view]);

  const updateInbox = useCallback(async (row: InboxRow, change: "read" | "archived") => {
    if (!bootstrap || !bootstrap.capabilities.some(capability => capability === INBOX_WRITE) || updatingItemId) return;
    const current = generation.current;
    setUpdatingItemId(row.id);
    try {
      await bridge.updateInboxState({ itemId: row.id, [change]: change === "read" ? row.unread : !row.archived });
      if (current !== generation.current) return;
      const nextSurface = parseSurface("inbox", await bridge.readSurface(readSurfaceRequest("inbox", archived)), bootstrap.workspace.id);
      if (current !== generation.current) return;
      setSurface(nextSurface);
    } catch {
      if (current === generation.current) {
        setBootstrap(null);
        setSurface(null);
        setFailed(true);
      }
    } finally {
      if (current === generation.current) setUpdatingItemId(null);
    }
  }, [archived, bootstrap, bridge, updatingItemId]);

  useEffect(() => {
    void load("workspace");
    return () => { generation.current += 1; };
  }, [load]);

  const workspaceName = bootstrap?.workspace.name;
  const retry = () => void load(view, archived);
  const openPlugin = useCallback(async (pluginId: string, surface: "shell" | "widget", surfaceId: string) => {
    setOpeningSurfaceId(surfaceId);
    setOpenFailed(false);
    try { await bridge.openPlugin({ pluginId, surface, surfaceId }); }
    catch { setOpenFailed(true); }
    finally { setOpeningSurfaceId(null); }
  }, [bridge]);

  return (
    <div className="min-h-dvh w-full bg-background px-5 py-6 text-foreground md:px-8">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-5">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SPS Native Workspace</p>
            {workspaceName && view !== "workspace"
              ? <h1 className="mt-1 break-words text-2xl font-semibold">{workspaceName}</h1>
              : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <nav aria-label="Workspace views" className="flex flex-wrap gap-2">
              {(["workspace", "dashboard", "inbox"] as const).map((nextView) => {
                const label = nextView === "workspace" ? "Workspace" : nextView === "dashboard" ? "Dashboard" : "Inbox";
                return (
                  <Button
                    key={nextView}
                    type="button"
                    aria-current={view === nextView ? "page" : undefined}
                    variant={view === nextView ? "default" : "outline"}
                    disabled={!bootstrap || loading || updatingItemId !== null}
                    onClick={() => void changeView(nextView)}
                  >
                    {label}
                  </Button>
                );
              })}
            </nav>
            <Button type="button" variant="outline" disabled={loading || updatingItemId !== null} onClick={retry} aria-busy={loading}>
              {updatingItemId !== null ? "Updating..." : loading ? "Loading..." : "Refresh"}
            </Button>
          </div>
        </header>
        {loading ? <main role="status" className="py-8 text-sm text-muted-foreground">Loading Workspace...</main> : null}
        {failed ? (
          <main className="space-y-3" role="alert">
            <p>{UNAVAILABLE}</p>
            <Button type="button" variant="outline" onClick={retry}>Retry</Button>
          </main>
        ) : null}
        {openFailed ? <p role="alert" className="text-sm text-destructive">The Plugin window could not be opened.</p> : null}
        {!loading && !failed && surface && workspaceName ? (
          surface.kind === "shell-neutral" || surface.kind === "shell-plugin-unavailable"
            ? <SurfaceContent model={surface} workspaceName={workspaceName} onOpenPlugin={openPlugin} openingSurfaceId={openingSurfaceId} />
            : <main><SurfaceContent model={surface} workspaceName={workspaceName}
              canWriteInbox={view === "inbox" && bootstrap.capabilities.some(capability => capability === INBOX_WRITE)}
              updatingItemId={updatingItemId}
              onUpdateInbox={view === "inbox" ? (row, change) => void updateInbox(row, change) : undefined}
              onToggleArchived={view === "inbox" && updatingItemId === null ? toggleArchived : undefined}
              archived={archived} onOpenPlugin={openPlugin} openingSurfaceId={openingSurfaceId} /></main>
        ) : null}
      </div>
    </div>
  );
}
