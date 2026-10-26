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
type DashboardRow = Readonly<{ title: string; description: string }>;
type InboxRow = Readonly<{ title: string; summary: string; severity: string }>;
type SurfaceModel =
  | Readonly<{ kind: "shell-neutral"; selectionUnavailable: boolean }>
  | Readonly<{ kind: "shell-plugin-unavailable" }>
  | Readonly<{ kind: "dashboard"; rows: readonly DashboardRow[] }>
  | Readonly<{ kind: "inbox"; rows: readonly InboxRow[] }>;

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const CAPABILITIES = [
  "workspace.shell.read",
  "workspace.dashboard.read",
  "workspace.inbox.read",
] as const;
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

export function parseNativeWorkspaceBootstrap(value: unknown): NativeWorkspaceBootstrap {
  const root = plainDataRecord(value, ["v", "kind", "workspace", "member", "capabilities"]);
  const workspace = plainDataRecord(root.workspace, ["id", "name", "issuePrefix"]);
  const member = plainDataRecord(root.member, ["userId"]);
  if (root.v !== 1 || root.kind !== "sps.native.workspace.bootstrap"
    || typeof workspace.id !== "string" || !UUID.test(workspace.id)
    || !nonemptyString(workspace.name) || !nonemptyString(workspace.issuePrefix)
    || !nonemptyString(member.userId)
    || !Array.isArray(root.capabilities)
    || root.capabilities.length !== CAPABILITIES.length
    || root.capabilities.some((capability, index) => capability !== CAPABILITIES[index])) {
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
    capabilities: Object.freeze([...CAPABILITIES]),
  });
}

function readSurfaceRequest(view: View): Readonly<{ surface: NativeWorkspaceSurface; archived?: boolean }> {
  if (view === "workspace") return Object.freeze({ surface: "shell" });
  if (view === "dashboard") return Object.freeze({ surface: "dashboard" });
  return Object.freeze({ surface: "inbox", archived: false });
}

function parseSurface(view: View, value: unknown): SurfaceModel {
  if (view === "workspace") {
    const shell = plainDataRecord(value, ["mode", "providerPluginId", "providerPluginKey", "shell", "fallbackReason"]);
    if (shell.mode === "neutral") {
      return Object.freeze({ kind: "shell-neutral", selectionUnavailable: nonemptyString(shell.fallbackReason) });
    }
    if (shell.mode === "plugin") return Object.freeze({ kind: "shell-plugin-unavailable" });
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
      return Object.freeze({ title: widget.displayName, description: typeof widget.description === "string" ? widget.description : "" });
    });
    return Object.freeze({ kind: "dashboard", rows: Object.freeze(rows) });
  }

  const inbox = plainDataRecord(value, ["items"]);
  if (!Array.isArray(inbox.items)) throw new Error(UNAVAILABLE);
  const rows = inbox.items.map(entry => {
    const item = plainDataRecord(entry);
    if (!nonemptyString(item.title) || typeof item.summary !== "string"
      || typeof item.severity !== "string"
      || !["info", "success", "warning", "error"].includes(item.severity)) throw new Error(UNAVAILABLE);
    return Object.freeze({ title: item.title, summary: item.summary, severity: item.severity });
  });
  return Object.freeze({ kind: "inbox", rows: Object.freeze(rows) });
}

function SurfaceContent({ model, workspaceName }: { model: SurfaceModel; workspaceName: string }) {
  if (model.kind === "shell-neutral") {
    return <SpsEmptyWorkspace workspaceName={workspaceName} selectionUnavailable={model.selectionUnavailable} />;
  }
  if (model.kind === "shell-plugin-unavailable") {
    return (
      <main className="min-h-dvh w-full bg-background px-6 py-12 text-foreground">
        <section className="mx-auto w-full max-w-2xl space-y-3">
          <h1 className="text-2xl font-semibold">{workspaceName}</h1>
          <p role="status" className="text-sm text-muted-foreground">
            This Workspace has a selected Plugin Shell, but its UI is not available in this Native connection.
          </p>
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
              These widgets are configured for this Workspace. Their Plugin views are not available on this Native connection yet.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {model.rows.map((row, index) => (
                <Card key={`${index}:${row.title}`}>
                  <CardHeader><CardTitle>{row.title}</CardTitle></CardHeader>
                  {row.description ? <CardContent>{row.description}</CardContent> : null}
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
      {model.rows.length === 0 ? <p className="text-sm text-muted-foreground">No inbox items.</p> : (
        <div className="space-y-3">
          {model.rows.map((row, index) => (
            <Card key={`${index}:${row.title}`}>
              <CardHeader>
                <CardTitle>{row.title}</CardTitle>
                <p className="text-xs text-muted-foreground">{row.severity}</p>
              </CardHeader>
              {row.summary ? <CardContent>{row.summary}</CardContent> : null}
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

  const load = useCallback(async (nextView: View) => {
    const current = ++generation.current;
    setBootstrap(null);
    setSurface(null);
    setView(nextView);
    setFailed(false);
    setLoading(true);
    try {
      const nextBootstrap = parseNativeWorkspaceBootstrap(await bridge.getBootstrap());
      if (current !== generation.current) return;
      setBootstrap(nextBootstrap);
      const nextSurface = parseSurface(nextView, await bridge.readSurface(readSurfaceRequest(nextView)));
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

  const changeView = useCallback(async (nextView: View) => {
    if (!bootstrap) return;
    const current = ++generation.current;
    setView(nextView);
    setSurface(null);
    setFailed(false);
    setLoading(true);
    try {
      const nextSurface = parseSurface(nextView, await bridge.readSurface(readSurfaceRequest(nextView)));
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

  useEffect(() => {
    void load("workspace");
    return () => { generation.current += 1; };
  }, [load]);

  const workspaceName = bootstrap?.workspace.name;
  const retry = () => void load(view);

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
                    disabled={!bootstrap || loading}
                    onClick={() => void changeView(nextView)}
                  >
                    {label}
                  </Button>
                );
              })}
            </nav>
            <Button type="button" variant="outline" disabled={loading} onClick={retry} aria-busy={loading}>
              {loading ? "Loading..." : "Refresh"}
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
        {!loading && !failed && surface && workspaceName ? (
          surface.kind === "shell-neutral" || surface.kind === "shell-plugin-unavailable"
            ? <SurfaceContent model={surface} workspaceName={workspaceName} />
            : <main><SurfaceContent model={surface} workspaceName={workspaceName} /></main>
        ) : null}
      </div>
    </div>
  );
}
