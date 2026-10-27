export type NativeWorkspaceSurface = "shell" | "providers" | "dashboard" | "inbox" | "executionControl";
export type NativeWorkspaceExecutionControl = Readonly<{
  state: "running" | "paused" | "stopped";
  epoch: string;
  revision: number;
  updatedAt: string | null;
  pending: Readonly<{ agents: number; jobs: number; models: number; commands: number; plugins: number }>;
  canControl: false;
}>;
export type NativeWorkspaceInboxState = Readonly<{
  readAt: string | null;
  archivedAt: string | null;
}>;

export type NativeWorkspaceBootstrap = Readonly<{
  v: 1;
  kind: "sps.native.workspace.bootstrap";
  workspace: Readonly<{ id: string; name: string; issuePrefix: string }>;
  member: Readonly<{ userId: string }>;
  capabilities:
    | readonly ["workspace.shell.read", "workspace.dashboard.read", "workspace.inbox.read"]
    | readonly ["workspace.shell.read", "workspace.dashboard.read", "workspace.inbox.read", "workspace.inbox.state.write"];
}>;

export interface SpsNativeWorkspaceBridge {
  getBootstrap(): Promise<unknown>;
  readSurface(input: Readonly<{ surface: NativeWorkspaceSurface; archived?: boolean }>): Promise<unknown>;
  updateInboxState(input: Readonly<{ itemId: string; read?: boolean; archived?: boolean }>): Promise<NativeWorkspaceInboxState>;
  openPlugin(input: Readonly<{ pluginId: string; surface: "shell" | "widget"; surfaceId: string }>): Promise<Readonly<{ opened: true }>>;
}

declare global {
  interface Window {
    readonly spsNativeWorkspace?: SpsNativeWorkspaceBridge;
  }
}
