/**
 * @fileoverview Plugin UI slot system — dynamic loading, error isolation,
 * and rendering of plugin-contributed UI extensions.
 *
 * Provides:
 * - `usePluginSlots(type, context?)` — React hook that discovers and
 *   filters plugin UI contributions for a given slot type.
 * - `PluginSlotOutlet` — renders all matching slots inline with error
 *   boundary isolation per plugin.
 * - `PluginBridgeScope` — wraps each plugin's component tree to inject
 *   the bridge context (`pluginId`, host context) needed by bridge hooks.
 *
 * Plugin UI modules are loaded via dynamic ESM `import()` from the host's
 * static file server (`/_plugins/:pluginId/ui/:entryFile`). Each module
 * exports named React components that correspond to `ui.slots[].exportName`
 * in the manifest.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 * @see PLUGIN_SPEC.md §19.0.3 — Bundle Serving
 */
import {
  Component,
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
  type ComponentType,
} from "react";
import * as ReactModule from "react";
import { applyJsxRuntimeKey, createPluginModuleLoader, createReactShimSource } from "./module-loader";
import { useQuery } from "@tanstack/react-query";
import type {
  PluginDashboardWidgetDeclaration,
  PluginLauncherDeclaration,
  PluginUiSlotDeclaration,
  PluginUiSlotEntityType,
  PluginUiSlotType,
} from "@paperclipai/shared";
import { pluginsApi, type PluginUiContribution } from "@/api/plugins";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import {
  PluginBridgeContext,
  usePluginData,
  type PluginHostContext,
} from "./bridge";

export type PluginSlotContext = {
  companyId?: string | null;
  companyPrefix?: string | null;
  projectId?: string | null;
  entityId?: string | null;
  entityType?: PluginUiSlotEntityType | null;
  /** Parent entity ID for nested slots (e.g. comment annotations within an issue). */
  parentEntityId?: string | null;
  projectRef?: string | null;
};

export type ResolvedPluginSlot = PluginUiSlotDeclaration & {
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  pluginVersion: string;
};

/**
 * Returns the unique `routeSidebar` slot that pairs with a single `page` slot
 * for the given route, or `null` if no unambiguous pairing exists.
 *
 * Used to detect when a route is taken over by a plugin's full-page sidebar so
 * host chrome (breadcrumb, in-page Back) can be suppressed.
 */
export function resolveRouteSidebarSlot(
  slots: ResolvedPluginSlot[],
  routePath: string | null,
): ResolvedPluginSlot | null {
  if (!routePath) return null;

  const pageMatches = slots.filter((slot) => slot.type === "page" && slot.routePath === routePath);
  if (pageMatches.length !== 1) return null;

  const [pageSlot] = pageMatches;
  const sidebarMatches = slots.filter((slot) =>
    slot.type === "routeSidebar"
    && slot.routePath === routePath
    && slot.pluginId === pageSlot.pluginId,
  );

  if (sidebarMatches.length !== 1) return null;
  return sidebarMatches[0] ?? null;
}

type PluginSlotComponentProps = {
  slot: ResolvedPluginSlot;
  context: PluginSlotContext;
};

export type RegisteredPluginComponent =
  | {
    kind: "react";
    component: ComponentType<PluginSlotComponentProps>;
  }
  | {
    kind: "web-component";
    tagName: string;
  };

type SlotFilters = {
  slotTypes: PluginUiSlotType[];
  entityType?: PluginUiSlotEntityType | null;
  companyId?: string | null;
  enabled?: boolean;
};

type UsePluginSlotsResult = {
  slots: ResolvedPluginSlot[];
  isLoading: boolean;
  errorMessage: string | null;
};

/**
 * In-memory registry for plugin UI exports loaded by the host page.
 * Keys are `${pluginKey}:${exportName}` to match manifest slot declarations.
 */
const registry = new Map<string, RegisteredPluginComponent>();
const registryListeners = new Set<() => void>();

function buildRegistryKey(pluginKey: string, exportName: string): string {
  return `${pluginKey}:${exportName}`;
}

function notifyRegistryListeners(): void {
  for (const listener of registryListeners) {
    listener();
  }
}

function usePluginRegistrySubscription(): void {
  const [, forceRerender] = useState(0);

  useEffect(() => {
    const listener = () => forceRerender((tick) => tick + 1);
    registryListeners.add(listener);
    return () => {
      registryListeners.delete(listener);
    };
  }, []);
}

function requiresEntityType(slotType: PluginUiSlotType): boolean {
  return slotType === "detailTab" || slotType === "agentConfiguration" || slotType === "taskDetailView" || slotType === "contextMenuItem" || slotType === "commentAnnotation" || slotType === "commentContextMenuItem" || slotType === "projectSidebarItem" || slotType === "toolbarButton";
}

function slotMatchesFilters(
  slot: PluginUiSlotDeclaration,
  allowedTypes: Set<PluginUiSlotType>,
  entityType: PluginUiSlotEntityType | null | undefined,
): boolean {
  if (!allowedTypes.has(slot.type)) return false;
  if (!requiresEntityType(slot.type)) return true;
  return Boolean(entityType && slot.entityTypes?.includes(entityType));
}

/**
 * A plugin can contribute UI to several unrelated host surfaces. Loading every
 * plugin module for each surface couples a single slow module to every route;
 * only load modules that can render a requested slot type.
 */
function filterContributionsForSlots(
  contributions: PluginUiContribution[] | undefined,
  allowedTypes: Set<PluginUiSlotType>,
  entityType: PluginUiSlotEntityType | null | undefined,
): PluginUiContribution[] {
  return (contributions ?? []).filter((contribution) =>
    contribution.slots.some((slot) => slotMatchesFilters(slot, allowedTypes, entityType)),
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

/**
 * Registers a React component export for a plugin UI slot.
 */
export function registerPluginReactComponent(
  pluginKey: string,
  exportName: string,
  component: ComponentType<PluginSlotComponentProps>,
): void {
  registry.set(buildRegistryKey(pluginKey, exportName), {
    kind: "react",
    component,
  });
  notifyRegistryListeners();
}

/**
 * Registers a custom element tag for a plugin UI slot.
 */
export function registerPluginWebComponent(
  pluginKey: string,
  exportName: string,
  tagName: string,
): void {
  registry.set(buildRegistryKey(pluginKey, exportName), {
    kind: "web-component",
    tagName,
  });
  notifyRegistryListeners();
}

function resolveRegisteredComponent(slot: ResolvedPluginSlot): RegisteredPluginComponent | null {
  return registry.get(buildRegistryKey(slot.pluginKey, slot.exportName)) ?? null;
}

export function resolveRegisteredPluginComponent(
  pluginKey: string,
  exportName: string,
): RegisteredPluginComponent | null {
  return registry.get(buildRegistryKey(pluginKey, exportName)) ?? null;
}

function isRegisterablePluginExport(exported: unknown): boolean {
  return typeof exported === "function" || typeof exported === "string";
}

function collectRegisterableExportNames(
  mod: Record<string, unknown>,
  declaredExports: Set<string>,
): Set<string> {
  const exportNames = new Set(declaredExports);
  for (const [exportName, exported] of Object.entries(mod)) {
    if (exportName === "default") continue;
    if (isRegisterablePluginExport(exported)) {
      exportNames.add(exportName);
    }
  }
  return exportNames;
}

// ---------------------------------------------------------------------------
// Plugin module dynamic import loader
// ---------------------------------------------------------------------------

type PluginLoadState = "idle" | "loading" | "loaded" | "error";

/**
 * Tracks the load state for each plugin's UI module by contribution cache key.
 *
 * Once a plugin module is loaded, all its named exports are inspected and
 * registered into the component `registry` so that `resolveRegisteredComponent`
 * can find them when slots render.
 */
const pluginLoadStates = new Map<string, PluginLoadState>();
const pluginLoadListeners = new Set<() => void>();

function setPluginLoadState(moduleKey: string, state: PluginLoadState): void {
  pluginLoadStates.set(moduleKey, state);
  for (const listener of pluginLoadListeners) {
    listener();
  }
}

/**
 * Promise cache to prevent concurrent duplicate imports for the same plugin.
 */
const inflightImports = new Map<string, Promise<void>>();
let pluginModuleLoader = createPluginModuleLoader({ reactModule: ReactModule });

function rewriteBareSpecifiers(source: string): string {
  return pluginModuleLoader.rewriteBareSpecifiers(source);
}

async function importPluginModule(url: string): Promise<Record<string, unknown>> {
  return pluginModuleLoader.importModule(url);
}

/**
 * Build the full URL for a plugin's UI entry module.
 *
 * The server serves plugin UI bundles at `/_plugins/:pluginId/ui/*`.
 * The `uiEntryFile` from the contribution (typically `"index.js"`) is
 * appended to form the complete import path.
 */
function buildPluginModuleKey(contribution: PluginUiContribution): string {
  const cacheHint = contribution.updatedAt ?? contribution.version ?? "0";
  return `${contribution.pluginId}:${cacheHint}`;
}

function buildPluginUiUrl(contribution: PluginUiContribution): string {
  const cacheHint = encodeURIComponent(contribution.updatedAt ?? contribution.version ?? "0");
  return `/_plugins/${encodeURIComponent(contribution.pluginId)}/ui/${contribution.uiEntryFile}?v=${cacheHint}`;
}

/** Import the module and register only exports declared by its contributions. */
async function loadPluginModule(contribution: PluginUiContribution): Promise<void> {
  const { pluginId, pluginKey, slots, launchers } = contribution;
  const moduleKey = buildPluginModuleKey(contribution);

  // Already loaded or loading — return early.
  const state = pluginLoadStates.get(moduleKey);
  if (state === "loaded" || state === "loading") {
    // If currently loading, wait for the inflight promise.
    const inflight = inflightImports.get(pluginId);
    if (inflight) await inflight;
    return;
  }

  // If another import for this plugin ID is currently in progress, wait for it.
  const running = inflightImports.get(pluginId);
  if (running) {
    await running;
    const recheckedState = pluginLoadStates.get(moduleKey);
    if (recheckedState === "loaded") {
      return;
    }
  }

  setPluginLoadState(moduleKey, "loading");

  const url = buildPluginUiUrl(contribution);

  const importPromise = (async () => {
    try {
      // Dynamic ESM import of the plugin's UI entry module with
      // bare-specifier rewriting for host-provided dependencies.
      const mod: Record<string, unknown> = await importPluginModule(url);

      // Collect the set of export names declared across all UI contributions so
      // we only register what the manifest advertises (ignore extra exports).
      const declaredExports = new Set<string>();
      for (const slot of slots) {
        declaredExports.add(slot.exportName);
      }
      for (const launcher of launchers) {
        if (launcher.exportName) {
          declaredExports.add(launcher.exportName);
        }
        if (isLauncherComponentTarget(launcher)) {
          declaredExports.add(launcher.action.target);
        }
      }

      const exportNames = collectRegisterableExportNames(mod, declaredExports);
      for (const exportName of exportNames) {
        const exported = mod[exportName];
        if (exported === undefined) {
          console.warn(
            `Plugin "${pluginKey}" declares slot export "${exportName}" but the module does not export it.`,
          );
          continue;
        }

        if (typeof exported === "function") {
          // React component (function component or class component).
          registerPluginReactComponent(
            pluginKey,
            exportName,
            exported as ComponentType<PluginSlotComponentProps>,
          );
        } else if (typeof exported === "string") {
          // Web component tag name.
          registerPluginWebComponent(pluginKey, exportName, exported);
        } else {
          console.warn(
            `Plugin "${pluginKey}" export "${exportName}" is neither a function nor a string tag name — skipping.`,
          );
        }
      }

      setPluginLoadState(moduleKey, "loaded");
    } catch (err) {
      setPluginLoadState(moduleKey, "error");
      console.error(`Failed to load UI module for plugin "${pluginKey}"`, err);
    } finally {
      inflightImports.delete(pluginId);
    }
  })();

  inflightImports.set(pluginId, importPromise);
  await importPromise;
}

function isLauncherComponentTarget(launcher: PluginLauncherDeclaration): boolean {
  return launcher.action.type === "openModal"
    || launcher.action.type === "openDrawer"
    || launcher.action.type === "openPopover";
}

/**
 * Load UI modules for a set of plugin contributions.
 *
 * Returns a promise that resolves once all modules have been loaded (or
 * failed). Plugins that are already loaded are skipped.
 */
async function ensurePluginModulesLoaded(contributions: PluginUiContribution[]): Promise<void> {
  await Promise.all(
    contributions.map((c) => loadPluginModule(c)),
  );
}

export async function ensurePluginContributionLoaded(
  contribution: PluginUiContribution,
): Promise<void> {
  await loadPluginModule(contribution);
}

/**
 * Returns the aggregate load state across a set of plugin contributions.
 * - If any plugin is still loading → "loading"
 * - If all are loaded (or no contributions) → "loaded"
 * - If all finished but some errored → "loaded" (errors are logged, not fatal)
 */
function aggregateLoadState(contributions: PluginUiContribution[]): "loading" | "loaded" {
  for (const c of contributions) {
    const state = pluginLoadStates.get(buildPluginModuleKey(c));
    if (state === "loading" || state === "idle" || state === undefined) {
      return "loading";
    }
  }
  return "loaded";
}

// ---------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------

/**
 * Trigger dynamic loading of plugin UI modules when contributions change.
 *
 * This hook is intentionally decoupled from usePluginSlots so that callers
 * who consume slots via `usePluginSlots()` automatically get module loading
 * without extra wiring.
 */
function usePluginModuleLoader(contributions: PluginUiContribution[] | undefined) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const listener = () => setTick((tick) => tick + 1);
    pluginLoadListeners.add(listener);
    return () => {
      pluginLoadListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!contributions || contributions.length === 0) return;

    // Filter to contributions that haven't been loaded yet.
    const unloaded = contributions.filter((c) => {
      const state = pluginLoadStates.get(buildPluginModuleKey(c));
      return state !== "loaded" && state !== "loading";
    });

    if (unloaded.length === 0) return;

    void ensurePluginModulesLoaded(unloaded);
  }, [contributions]);
}

/**
 * Resolves and sorts slots across all ready plugin contributions.
 *
 * Filtering rules:
 * - `slotTypes` must match one of the caller-requested host slot types.
 * - Entity-scoped slot types (`detailTab`, `taskDetailView`, `contextMenuItem`)
 *   require `entityType` and must include it in `slot.entityTypes`.
 *
 * Automatically triggers dynamic import of plugin UI modules for any
 * newly-discovered contributions. Components render once loading completes.
 */
export function usePluginSlots(filters: SlotFilters): UsePluginSlotsResult {
  const queryEnabled = filters.enabled ?? true;
  const { data, isLoading: isQueryLoading, error } = useQuery({
    queryKey: queryKeys.plugins.uiContributions(filters.companyId),
    queryFn: () => pluginsApi.listUiContributions(filters.companyId),
    enabled: queryEnabled,
  });

  const slotTypesKey = useMemo(() => [...filters.slotTypes].sort().join("|"), [filters.slotTypes]);
  const allowedTypes = useMemo(
    () => new Set(slotTypesKey.split("|").filter(Boolean) as PluginUiSlotType[]),
    [slotTypesKey],
  );
  const matchingContributions = useMemo(
    () => filterContributionsForSlots(data, allowedTypes, filters.entityType),
    [allowedTypes, data, filters.entityType],
  );

  // Kick off imports only for modules capable of rendering this host surface.
  usePluginModuleLoader(matchingContributions);

  const slots = useMemo(() => {
    const rows: ResolvedPluginSlot[] = [];
    for (const contribution of matchingContributions) {
      for (const slot of contribution.slots) {
        if (!slotMatchesFilters(slot, allowedTypes, filters.entityType)) continue;
        rows.push({
          ...slot,
          pluginId: contribution.pluginId,
          pluginKey: contribution.pluginKey,
          pluginDisplayName: contribution.displayName,
          pluginVersion: contribution.version,
        });
      }
    }
    rows.sort((a, b) => {
      const ao = a.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      const pluginCmp = a.pluginDisplayName.localeCompare(b.pluginDisplayName);
      if (pluginCmp !== 0) return pluginCmp;
      return a.displayName.localeCompare(b.displayName);
    });
    return rows;
  }, [allowedTypes, filters.entityType, matchingContributions]);

  // Consider loading until both query and module imports are done.
  const modulesLoaded = data ? aggregateLoadState(matchingContributions) === "loaded" : true;
  const isLoading = queryEnabled && (isQueryLoading || !modulesLoaded);

  return {
    slots,
    isLoading,
    errorMessage: error ? getErrorMessage(error) : null,
  };
}

type PluginSlotErrorBoundaryProps = {
  slot: ResolvedPluginSlot;
  className?: string;
  children: ReactNode;
};

type PluginSlotErrorBoundaryState = {
  hasError: boolean;
};

class PluginSlotErrorBoundary extends Component<PluginSlotErrorBoundaryProps, PluginSlotErrorBoundaryState> {
  override state: PluginSlotErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PluginSlotErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep plugin failures isolated while preserving actionable diagnostics.
    console.error("Plugin slot render failed", {
      pluginKey: this.props.slot.pluginKey,
      slotId: this.props.slot.id,
      error,
      info: info.componentStack,
    });
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className={cn("rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive", this.props.className)}>
          {this.props.slot.pluginDisplayName}: failed to render
        </div>
      );
    }
    return this.props.children;
  }
}

function PluginWebComponentMount({
  tagName,
  slot,
  context,
  className,
}: {
  tagName: string;
  slot: ResolvedPluginSlot;
  context: PluginSlotContext;
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    // Bridge manifest slot/context metadata onto the custom element instance.
    const el = ref.current as HTMLElement & {
      pluginSlot?: ResolvedPluginSlot;
      pluginContext?: PluginSlotContext;
    };
    el.pluginSlot = slot;
    el.pluginContext = context;
  }, [context, slot]);

  return createElement(tagName, { ref, className });
}

type PluginSlotMountProps = {
  slot: ResolvedPluginSlot;
  context: PluginSlotContext;
  className?: string;
  missingBehavior?: "hidden" | "placeholder";
};

/**
 * Maps the slot's `PluginSlotContext` to a `PluginHostContext` for the bridge.
 *
 * The bridge hooks need the full host context shape; the slot context carries
 * the subset available from the rendering location.
 */
function slotContextToHostContext(
  pluginSlotContext: PluginSlotContext,
  userId: string | null,
): PluginHostContext {
  return {
    companyId: pluginSlotContext.companyId ?? null,
    companyPrefix: pluginSlotContext.companyPrefix ?? null,
    projectId: pluginSlotContext.projectId ?? (pluginSlotContext.entityType === "project" ? pluginSlotContext.entityId ?? null : null),
    entityId: pluginSlotContext.entityId ?? null,
    entityType: pluginSlotContext.entityType ?? null,
    parentEntityId: pluginSlotContext.parentEntityId ?? null,
    userId,
    renderEnvironment: null,
  };
}

/**
 * Wrapper component that sets the active bridge context around plugin renders.
 *
 * This ensures that `usePluginData()`, `usePluginAction()`, and `useHostContext()`
 * have access to the current plugin ID and host context during the render phase.
 */
function PluginBridgeScope({
  pluginId,
  context,
  children,
}: {
  pluginId: string;
  context: PluginSlotContext;
  children: ReactNode;
}) {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId ?? null;
  const hostContext = useMemo(() => slotContextToHostContext(context, userId), [context, userId]);
  const value = useMemo(() => ({ pluginId, hostContext }), [pluginId, hostContext]);

  return (
    <PluginBridgeContext.Provider value={value}>
      {children}
    </PluginBridgeContext.Provider>
  );
}

export function PluginSlotMount({
  slot,
  context,
  className,
  missingBehavior = "hidden",
}: PluginSlotMountProps) {
  usePluginRegistrySubscription();
  const [, forceRerender] = useState(0);
  const component = resolveRegisteredComponent(slot);

  useEffect(() => {
    if (component) return;
    const inflight = inflightImports.get(slot.pluginId);
    if (!inflight) return;

    let cancelled = false;
    void inflight.finally(() => {
      if (!cancelled) {
        forceRerender((tick) => tick + 1);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [component, slot.pluginId]);

  if (!component) {
    if (missingBehavior === "hidden") return null;
    return (
      <div className={cn("rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground", className)}>
        {slot.pluginDisplayName}: {slot.displayName}
      </div>
    );
  }

  if (component.kind === "react") {
    const node = createElement(component.component, { slot, context });
    return (
      <PluginSlotErrorBoundary slot={slot} className={className}>
        <PluginBridgeScope pluginId={slot.pluginId} context={context}>
          {className ? <div className={className}>{node}</div> : node}
        </PluginBridgeScope>
      </PluginSlotErrorBoundary>
    );
  }

  return (
    <PluginSlotErrorBoundary slot={slot} className={className}>
      <PluginWebComponentMount
        tagName={component.tagName}
        slot={slot}
        context={context}
        className={className}
      />
    </PluginSlotErrorBoundary>
  );
}

export type PluginDashboardWidgetMountProps = {
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  pluginVersion: string;
  widget: PluginDashboardWidgetDeclaration;
  context: PluginSlotContext;
  className?: string;
};

type PluginDashboardWidgetComponentProps = {
  widget: PluginDashboardWidgetDeclaration;
  context: PluginSlotContext;
  data: unknown;
  loading: boolean;
  error: { code: string; message: string; details?: unknown } | null;
  refresh(): void;
};

function dashboardWidgetSlot(
  props: PluginDashboardWidgetMountProps,
): ResolvedPluginSlot {
  return {
    id: `dashboard:${props.widget.id}`,
    type: "page",
    displayName: props.widget.displayName,
    exportName: props.widget.exportName,
    pluginId: props.pluginId,
    pluginKey: props.pluginKey,
    pluginDisplayName: props.pluginDisplayName,
    pluginVersion: props.pluginVersion,
  };
}

function PluginDashboardWebComponent({
  tagName,
  widget,
  context,
  result,
  className,
}: {
  tagName: string;
  widget: PluginDashboardWidgetDeclaration;
  context: PluginSlotContext;
  result: ReturnType<typeof usePluginData>;
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const element = ref.current as HTMLElement & PluginDashboardWidgetComponentProps;
    element.widget = widget;
    element.context = context;
    element.data = result.data;
    element.loading = result.loading;
    element.error = result.error;
    element.refresh = result.refresh;
  }, [context, result.data, result.error, result.loading, result.refresh, widget]);

  return createElement(tagName, { ref, className });
}

function PluginDashboardWidgetBody({
  component,
  widget,
  context,
  className,
}: {
  component: RegisteredPluginComponent;
  widget: PluginDashboardWidgetDeclaration;
  context: PluginSlotContext;
  className?: string;
}) {
  const result = usePluginData(widget.dataAction, {
    companyId: context.companyId ?? undefined,
  });

  if (result.loading) {
    return (
      <div className={cn("flex min-h-24 items-center justify-center text-sm text-muted-foreground", className)}>
        Loading {widget.displayName}...
      </div>
    );
  }
  if (result.error) {
    return (
      <div className={cn("rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive", className)}>
        {widget.displayName}: {result.error.message}
      </div>
    );
  }

  if (component.kind === "react") {
    return createElement(
      component.component as unknown as ComponentType<PluginDashboardWidgetComponentProps>,
      {
        widget,
        context,
        data: result.data,
        loading: result.loading,
        error: result.error,
        refresh: result.refresh,
      },
    );
  }

  return (
    <PluginDashboardWebComponent
      tagName={component.tagName}
      widget={widget}
      context={context}
      result={result}
      className={className}
    />
  );
}

/**
 * Renders one manifest-declared Dashboard widget with the same module loader,
 * bridge scope, and failure isolation used by regular plugin slots.
 */
export function PluginDashboardWidgetMount(props: PluginDashboardWidgetMountProps) {
  usePluginRegistrySubscription();
  const [, forceRerender] = useState(0);
  const slot = useMemo(() => dashboardWidgetSlot(props), [props]);
  const component = resolveRegisteredComponent(slot);

  useEffect(() => {
    if (component) return;
    const inflight = inflightImports.get(props.pluginId);
    if (!inflight) return;
    let cancelled = false;
    void inflight.finally(() => {
      if (!cancelled) forceRerender((tick) => tick + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [component, props.pluginId]);

  if (!component) {
    return (
      <div className={cn("rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground", props.className)}>
        {props.pluginDisplayName}: {props.widget.displayName} is unavailable
      </div>
    );
  }

  return (
    <PluginSlotErrorBoundary slot={slot} className={props.className}>
      <PluginBridgeScope pluginId={props.pluginId} context={props.context}>
        <PluginDashboardWidgetBody
          component={component}
          widget={props.widget}
          context={props.context}
          className={props.className}
        />
      </PluginBridgeScope>
    </PluginSlotErrorBoundary>
  );
}

type PluginSlotOutletProps = {
  slotTypes: PluginUiSlotType[];
  context: PluginSlotContext;
  entityType?: PluginUiSlotEntityType | null;
  className?: string;
  itemClassName?: string;
  errorClassName?: string;
  missingBehavior?: "hidden" | "placeholder";
};

export function PluginSlotOutlet({
  slotTypes,
  context,
  entityType,
  className,
  itemClassName,
  errorClassName,
  missingBehavior = "hidden",
}: PluginSlotOutletProps) {
  const { slots, errorMessage } = usePluginSlots({
    slotTypes,
    entityType,
    companyId: context.companyId,
  });

  if (errorMessage) {
    return (
      <div className={cn("rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive", errorClassName)}>
        Plugin extensions unavailable: {errorMessage}
      </div>
    );
  }

  if (slots.length === 0) return null;

  return (
    <div className={className}>
      {slots.map((slot) => (
        <PluginSlotMount
          key={`${slot.pluginKey}:${slot.id}`}
          slot={slot}
          context={context}
          className={itemClassName}
          missingBehavior={missingBehavior}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test helpers — exported for use in test suites only.
// ---------------------------------------------------------------------------

/**
 * Reset the module loader state. Only use in tests.
 * @internal
 */
export function _resetPluginModuleLoader(): void {
  pluginLoadStates.clear();
  inflightImports.clear();
  registry.clear();
  pluginLoadListeners.clear();
  pluginModuleLoader.dispose();
  pluginModuleLoader = createPluginModuleLoader({ reactModule: ReactModule });
}

export const _applyJsxRuntimeKeyForTests = applyJsxRuntimeKey;
export const _createReactShimSourceForTests = createReactShimSource;
export const _rewriteBareSpecifiersForTests = rewriteBareSpecifiers;
export const _collectRegisterableExportNamesForTests = collectRegisterableExportNames;
export const _filterContributionsForSlotsForTests = filterContributionsForSlots;
export const _setPluginLoadStateForTests = setPluginLoadState;
export const _registerPluginLoadListenerForTests = (listener: () => void): void => {
  pluginLoadListeners.add(listener);
};
export const _unregisterPluginLoadListenerForTests = (listener: () => void): void => {
  pluginLoadListeners.delete(listener);
};
