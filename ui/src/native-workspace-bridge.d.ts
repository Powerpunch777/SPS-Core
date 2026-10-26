export type NativeWorkspaceSurface = "shell" | "providers" | "dashboard" | "inbox";
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
}

declare global {
  interface Window {
    readonly spsNativeWorkspace?: SpsNativeWorkspaceBridge;
  }
}
