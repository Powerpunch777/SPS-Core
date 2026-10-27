/**
 * Pure Plugin ESM loading primitives. This module deliberately has no app,
 * API, router, or slot dependencies so each renderer realm can own an instance.
 */

export type PluginModuleLoader = Readonly<{
  rewriteBareSpecifiers(source: string): string;
  importModule(url: string): Promise<Record<string, unknown>>;
  dispose(): void;
}>;

export type PluginModuleLoaderOptions = Readonly<{
  /** React module whose public exports the plugin bundle expects. */
  reactModule: object;
  /** Existing per-realm bridge global. Defaults to the Core Plugin bridge name. */
  runtimeGlobalName?: string;
}>;

type ShimSpecifier = "react" | "react-dom" | "react-dom/client" | "react/jsx-runtime" | "sdk-ui";

function validateRuntimeGlobalName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_$][\w$]*$/.test(value)) {
    throw new TypeError("Plugin module loader runtime global name is invalid.");
  }
  return value;
}

function runtimeExpression(globalName: string): string {
  return `globalThis[${JSON.stringify(globalName)}]`;
}

export function applyJsxRuntimeKey(
  props: Record<string, unknown> | null | undefined,
  key: string | number | undefined,
): Record<string, unknown> {
  if (key === undefined) return props ?? {};
  return { ...(props ?? {}), key };
}

export function createReactShimSource(reactModule: object, runtimeGlobalName = "__paperclipPluginBridge__"): string {
  const globalName = validateRuntimeGlobalName(runtimeGlobalName);
  const exportNames = Object.keys(reactModule)
    .filter((name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name))
    .sort();
  const namedExports = exportNames
    .map((name) => `        export const ${name} = R.${name};`)
    .join("\n");
  const registry = runtimeExpression(globalName);

  return `
        const R = ${registry}?.react;
        if (!R) {
          throw new Error("SPS plugin React runtime is not initialized.");
        }
        export default R;
${namedExports}
      `;
}

function createSdkUiShimSource(runtimeGlobalName: string): string {
  const registry = runtimeExpression(runtimeGlobalName);
  return `
        const SDK = ${registry}?.sdkUi ?? {};
        function missing(name) {
          return function MissingPaperclipSdkUiComponent() {
            throw new Error('SPS plugin UI runtime is not initialized for "' + name + '". Ensure the host loaded the plugin bridge before rendering this UI module.');
          };
        }
        const { usePluginData, usePluginAction, useHostContext, useHostLocation, useHostNavigation, usePluginStream, usePluginToast } = SDK;
        const MetricCard = SDK.MetricCard ?? missing("MetricCard");
        const StatusBadge = SDK.StatusBadge ?? missing("StatusBadge");
        const DataTable = SDK.DataTable ?? missing("DataTable");
        const TimeseriesChart = SDK.TimeseriesChart ?? missing("TimeseriesChart");
        const MarkdownBlock = SDK.MarkdownBlock ?? missing("MarkdownBlock");
        const MarkdownEditor = SDK.MarkdownEditor ?? missing("MarkdownEditor");
        const KeyValueList = SDK.KeyValueList ?? missing("KeyValueList");
        const ActionBar = SDK.ActionBar ?? missing("ActionBar");
        const LogView = SDK.LogView ?? missing("LogView");
        const JsonTree = SDK.JsonTree ?? missing("JsonTree");
        const Spinner = SDK.Spinner ?? missing("Spinner");
        const ErrorBoundary = SDK.ErrorBoundary ?? missing("ErrorBoundary");
        const FileTree = SDK.FileTree ?? missing("FileTree");
        const IssuesList = SDK.IssuesList ?? missing("IssuesList");
        const AssigneePicker = SDK.AssigneePicker ?? missing("AssigneePicker");
        const ProjectPicker = SDK.ProjectPicker ?? missing("ProjectPicker");
        const ManagedRoutinesList = SDK.ManagedRoutinesList ?? missing("ManagedRoutinesList");
        export { usePluginData, usePluginAction, useHostContext, useHostLocation, useHostNavigation, usePluginStream, usePluginToast, MetricCard, StatusBadge, DataTable, TimeseriesChart, MarkdownBlock, MarkdownEditor, KeyValueList, ActionBar, LogView, JsonTree, Spinner, ErrorBoundary, FileTree, IssuesList, AssigneePicker, ProjectPicker, ManagedRoutinesList };
      `;
}

export function createPluginModuleLoader(options: PluginModuleLoaderOptions): PluginModuleLoader {
  if (!options || typeof options !== "object" || !options.reactModule || typeof options.reactModule !== "object") {
    throw new TypeError("Plugin module loader requires the realm's React module.");
  }
  const runtimeGlobalName = validateRuntimeGlobalName(options.runtimeGlobalName ?? "__paperclipPluginBridge__");
  const shimBlobUrls = new Map<ShimSpecifier, string>();
  const ownedBlobUrls = new Set<string>();
  let disposed = false;

  function assertActive(): void {
    if (disposed) throw new Error("SPS plugin module loader has been disposed.");
  }

  function ownBlobUrl(source: string): string {
    const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
    ownedBlobUrls.add(url);
    return url;
  }

  function revokeBlobUrl(url: string): void {
    if (ownedBlobUrls.delete(url)) URL.revokeObjectURL(url);
  }

  function shimBlobUrl(specifier: ShimSpecifier): string {
    assertActive();
    const existing = shimBlobUrls.get(specifier);
    if (existing) return existing;

    let source: string;
    switch (specifier) {
      case "react":
        source = createReactShimSource(options.reactModule, runtimeGlobalName);
        break;
      case "react/jsx-runtime": {
        const registry = runtimeExpression(runtimeGlobalName);
        source = `
        const R = ${registry}?.react;
        const withKey = ${applyJsxRuntimeKey.toString()};
        export const jsx = (type, props, key) => R.createElement(type, withKey(props, key));
        export const jsxs = (type, props, key) => R.createElement(type, withKey(props, key));
        export const Fragment = R.Fragment;
      `;
        break;
      }
      case "react-dom":
      case "react-dom/client": {
        const registry = runtimeExpression(runtimeGlobalName);
        source = `
        const RD = ${registry}?.reactDom;
        export default RD;
        const { createRoot, hydrateRoot, createPortal, flushSync } = RD ?? {};
        export { createRoot, hydrateRoot, createPortal, flushSync };
      `;
        break;
      }
      case "sdk-ui":
        source = createSdkUiShimSource(runtimeGlobalName);
        break;
    }

    const url = ownBlobUrl(source);
    shimBlobUrls.set(specifier, url);
    return url;
  }

  function rewriteBareSpecifiers(source: string): string {
    assertActive();
    const rewrites: Record<string, string> = {
      '"@sonparkserver/plugin-sdk/ui/bridge"': `"${shimBlobUrl("sdk-ui")}"`,
      "'@sonparkserver/plugin-sdk/ui/bridge'": `'${shimBlobUrl("sdk-ui")}'`,
      '"@paperclipai/plugin-sdk/ui"': `"${shimBlobUrl("sdk-ui")}"`,
      "'@paperclipai/plugin-sdk/ui'": `'${shimBlobUrl("sdk-ui")}'`,
      '"@paperclipai/plugin-sdk/ui/hooks"': `"${shimBlobUrl("sdk-ui")}"`,
      "'@paperclipai/plugin-sdk/ui/hooks'": `'${shimBlobUrl("sdk-ui")}'`,
      '"react/jsx-runtime"': `"${shimBlobUrl("react/jsx-runtime")}"`,
      "'react/jsx-runtime'": `'${shimBlobUrl("react/jsx-runtime")}'`,
      '"react-dom/client"': `"${shimBlobUrl("react-dom/client")}"`,
      "'react-dom/client'": `'${shimBlobUrl("react-dom/client")}'`,
      '"react-dom"': `"${shimBlobUrl("react-dom")}"`,
      "'react-dom'": `'${shimBlobUrl("react-dom")}'`,
      '"react"': `"${shimBlobUrl("react")}"`,
      "'react'": `'${shimBlobUrl("react")}'`,
    };

    let result = source;
    for (const [from, to] of Object.entries(rewrites)) {
      result = result.replaceAll(` from ${from}`, ` from ${to}`);
      result = result.replaceAll(`import ${from}`, `import ${to}`);
    }
    return result;
  }

  async function importModule(url: string): Promise<Record<string, unknown>> {
    assertActive();
    const runtime = (globalThis as unknown as Record<string, unknown>)[runtimeGlobalName];
    if (!runtime) {
      console.warn("[plugin-loader] Bridge registry not initialized, falling back to direct import");
      const mod = await import(/* @vite-ignore */ url);
      assertActive();
      return mod;
    }

    const response = await fetch(url);
    assertActive();
    if (!response.ok) throw new Error(`Failed to fetch plugin module: ${response.status} ${response.statusText}`);
    const rewritten = rewriteBareSpecifiers(await response.text());
    const blobUrl = ownBlobUrl(rewritten);
    try {
      const mod = await import(/* @vite-ignore */ blobUrl);
      assertActive();
      return mod;
    } finally {
      revokeBlobUrl(blobUrl);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const url of ownedBlobUrls) URL.revokeObjectURL(url);
    ownedBlobUrls.clear();
    shimBlobUrls.clear();
  }

  return Object.freeze({ rewriteBareSpecifiers, importModule, dispose });
}
