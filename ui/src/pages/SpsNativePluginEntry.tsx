import * as React from "react";
import * as ReactDOM from "react-dom";
import { createPluginModuleLoader } from "../plugins/module-loader";
import { createNativePluginSdk, useNativePluginData } from "../plugins/native-plugin-sdk";
import type { NativePluginBootstrap, NativePluginContext, NativePluginDescriptor, SpsNativePluginBridge } from "../native-plugin-bridge";

const ERROR = "This Plugin view is unavailable in the Native connection.";
const DESCRIPTOR_KEYS = ["v", "kind", "workspaceId", "pluginId", "pluginKey", "displayName", "revision", "surface", "surfaceId", "entryFile", "exportName", "widget", "slot", "cssFiles"] as const;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(ERROR);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(descriptors);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(ERROR);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key as never))) throw new Error(ERROR);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error(ERROR);
    result[key] = descriptor.value;
  }
  return result;
}

function parseDescriptor(value: unknown): NativePluginDescriptor {
  const item = record(value, DESCRIPTOR_KEYS);
  if (item.v !== 1 || item.kind !== "sps.native.plugin.surface"
    || typeof item.workspaceId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(item.workspaceId)
    || typeof item.pluginId !== "string" || item.pluginId.length === 0 || item.pluginId.length > 200
    || typeof item.pluginKey !== "string" || item.pluginKey.length === 0 || item.pluginKey.length > 200
    || typeof item.displayName !== "string" || item.displayName.length === 0 || item.displayName.length > 200
    || typeof item.revision !== "string" || !/^[0-9a-f]{64}$/.test(item.revision)
    || (item.surface !== "shell" && item.surface !== "widget")
    || typeof item.surfaceId !== "string" || item.surfaceId.length === 0 || item.surfaceId.length > 200
    || item.entryFile !== "index.js" || typeof item.exportName !== "string" || item.exportName.length === 0
    || (item.widget !== null && (!item.widget || typeof item.widget !== "object" || Array.isArray(item.widget)))
    || (item.slot !== null && (!item.slot || typeof item.slot !== "object" || Array.isArray(item.slot)))
    || !Array.isArray(item.cssFiles) || item.cssFiles.length > 32
    || item.cssFiles.some(file => typeof file !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.css$/.test(file))) throw new Error(ERROR);
  if (item.surface === "widget" && (!item.widget || item.slot !== null)) throw new Error(ERROR);
  if (item.surface === "shell" && (!item.slot || item.widget !== null)) throw new Error(ERROR);
  if (item.surface === "widget") {
    const widget = item.widget as Record<string, unknown>;
    if (widget.id !== item.surfaceId || widget.exportName !== item.exportName
      || typeof widget.dataAction !== "string" || widget.dataAction.length === 0) throw new Error(ERROR);
  } else {
    const slot = item.slot as Record<string, unknown>;
    if (slot.type !== "page" || slot.exportName !== item.exportName
      || typeof slot.routePath !== "string" || slot.routePath.length === 0) throw new Error(ERROR);
  }
  return Object.freeze({ ...item, cssFiles: Object.freeze([...item.cssFiles]) }) as NativePluginDescriptor;
}

function ErrorBoundary({ children }: { children: React.ReactNode }) {
  return <Boundary>{children}</Boundary>;
}

class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main role="alert" className="p-6">{ERROR}</main> : this.props.children; }
}

function NativePluginSurface({ bridge, bootstrap, component }: {
  bridge: SpsNativePluginBridge;
  bootstrap: NativePluginBootstrap;
  component: React.ComponentType<Record<string, unknown>>;
}) {
  const descriptor = bootstrap.descriptor;
  const context = Object.freeze({
    companyId: bootstrap.workspace.id,
    companyPrefix: bootstrap.workspace.issuePrefix,
    projectId: null,
    entityId: null,
    entityType: null,
    userId: bootstrap.member.userId,
  });
  if (descriptor.surface === "widget") {
    return <NativePluginWidget bridge={bridge} context={context} widget={descriptor.widget!} component={component} />;
  }
  return React.createElement(component, { slot: descriptor.slot, context });
}

function NativePluginWidget({ bridge, context, widget, component }: {
  bridge: SpsNativePluginBridge;
  context: NativePluginContext;
  widget: Readonly<Record<string, unknown>>;
  component: React.ComponentType<Record<string, unknown>>;
}) {
  const key = typeof widget.dataAction === "string" ? widget.dataAction : "";
  const result = useNativePluginData(bridge, key, { companyId: context.companyId });
  return React.createElement(component, { widget, context, data: result.data, loading: result.loading,
    error: result.error, refresh: result.refresh });
}

export function SpsNativePluginEntry({ bridge }: { bridge: SpsNativePluginBridge }) {
  const [state, setState] = React.useState<{ bootstrap: NativePluginBootstrap; component: React.ComponentType<Record<string, unknown>> } | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    let loader: ReturnType<typeof createPluginModuleLoader> | null = null;
    const cssLinks: HTMLLinkElement[] = [];
    void (async () => {
      try {
        const raw = record(await bridge.bootstrap(), ["descriptor", "workspace", "member"]);
        const descriptor = parseDescriptor(raw.descriptor);
        const workspace = record(raw.workspace, ["id", "name", "issuePrefix"]);
        const member = record(raw.member, ["userId"]);
        if (workspace.id !== descriptor.workspaceId || typeof workspace.name !== "string" || workspace.name.length === 0
          || typeof workspace.issuePrefix !== "string" || workspace.issuePrefix.length === 0
          || typeof member.userId !== "string" || member.userId.length === 0) throw new Error(ERROR);
        const bootstrap = Object.freeze({ descriptor, workspace: Object.freeze({ id: workspace.id, name: workspace.name, issuePrefix: workspace.issuePrefix }), member: Object.freeze({ userId: member.userId }) }) as NativePluginBootstrap;
        for (const file of descriptor.cssFiles) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = `/plugin/${file}`;
          document.head.appendChild(link);
          cssLinks.push(link);
        }
        const importMapNonce = document.querySelector('meta[name="sps-native-plugin-nonce"]')?.getAttribute("content") ?? undefined;
        loader = createPluginModuleLoader({ reactModule: React, runtimeGlobalName: "__spsNativePluginBridge__", nativeImportMap: true, importMapNonce });
        const runtime = createNativePluginSdk(bridge, Object.freeze({ companyId: workspace.id, companyPrefix: workspace.issuePrefix, projectId: null, entityId: null, entityType: null, userId: member.userId }), React, ReactDOM);
        Object.defineProperty(globalThis, "__spsNativePluginBridge__", { configurable: true, value: runtime });
        loader.installImportMap();
        const module = await loader.importModule("/plugin/index.js");
        const exported = module[descriptor.exportName];
        if (typeof exported !== "function") throw new Error(ERROR);
        if (active) setState({ bootstrap, component: exported as React.ComponentType<Record<string, unknown>> });
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
      loader?.dispose();
      for (const link of cssLinks) link.remove();
      try { delete (globalThis as Record<string, unknown>).__spsNativePluginBridge__; } catch { /* Realm may already be closing. */ }
    };
  }, [bridge]);

  if (failed) return <main role="alert" className="p-6">{ERROR}</main>;
  if (!state) return <main role="status" className="p-6">Loading Plugin view...</main>;
  return <ErrorBoundary><NativePluginSurface bridge={bridge} bootstrap={state.bootstrap} component={state.component} /></ErrorBoundary>;
}
