export type NativePluginSurface = "shell" | "widget";

export type NativePluginDescriptor = Readonly<{
  v: 1;
  kind: "sps.native.plugin.surface";
  workspaceId: string;
  pluginId: string;
  pluginKey: string;
  displayName: string;
  revision: string;
  surface: NativePluginSurface;
  surfaceId: string;
  entryFile: "index.js";
  exportName: string;
  widget: Readonly<Record<string, unknown>> | null;
  slot: Readonly<Record<string, unknown>> | null;
  cssFiles: readonly string[];
}>;

export type NativePluginContext = Readonly<{
  companyId: string;
  companyPrefix: string;
  projectId: null;
  entityId: null;
  entityType: null;
  userId: string;
}>;

export type NativePluginBootstrap = Readonly<{
  descriptor: NativePluginDescriptor;
  workspace: Readonly<{ id: string; name: string; issuePrefix: string }>;
  member: Readonly<{ userId: string }>;
}>;

export interface SpsNativePluginBridge {
  bootstrap(): Promise<unknown>;
  getData(key: string, params?: Record<string, unknown>): Promise<Readonly<{ data: unknown }>>;
  performAction(key: string, params?: Record<string, unknown>): Promise<Readonly<{ data: unknown }>>;
  close?(): Promise<void>;
}

declare global {
  interface Window {
    readonly spsNativePlugin?: SpsNativePluginBridge;
  }
}
