export type NativeWorkspaceSurface = "shell" | "providers" | "dashboard" | "inbox";

export type NativeWorkspaceBootstrap = Readonly<{
  v: 1;
  kind: "sps.native.workspace.bootstrap";
  workspace: Readonly<{ id: string; name: string; issuePrefix: string }>;
  member: Readonly<{ userId: string }>;
  capabilities: readonly ["workspace.shell.read", "workspace.dashboard.read", "workspace.inbox.read"];
}>;

export interface SpsNativeWorkspaceBridge {
  getBootstrap(): Promise<unknown>;
  readSurface(input: Readonly<{ surface: NativeWorkspaceSurface; archived?: boolean }>): Promise<unknown>;
}

declare global {
  interface Window {
    readonly spsNativeWorkspace?: SpsNativeWorkspaceBridge;
  }
}
