import {
  createHostClientHandlers,
  InvocationScopeDeniedError,
  type HostServices,
  type WorkerHostCallContext,
  type WorkerToHostMethodName,
} from "../compat/paperclip/plugin-sdk.js";
import type { PaperclipPluginManifestV1 } from "../compat/paperclip/shared.js";
import type { WorkerToHostHandlers } from "../compat/paperclip/control-plane.js";

// This lane exposes neutral, tenant-selected services. Host lifecycle/tool/event
// registration, raw SQL, direct outbound HTTP and raw secret resolution are not
// part of the Workspace worker contract. Missing methods fail explicitly.
const METHODS: readonly WorkerToHostMethodName[] = [
  "config.get", "state.get", "state.set", "state.delete",
  "entities.upsert", "entities.list", "inbox.publish", "inbox.update", "inbox.withdraw",
  "localFolders.declarations", "localFolders.status", "localFolders.list",
  "localFolders.readText", "localFolders.writeTextAtomic", "localFolders.deleteFile",
  "sps.executions.list", "sps.executions.get", "sps.executions.summarize",
  "sps.workspaceSources.list", "sps.runtimes.list", "sps.connectivity.current",
  "sps.models.list", "sps.models.submit", "sps.models.get", "sps.models.cancel",
  "sps.executionGrants.list", "sps.runs.dispatch", "sps.runs.get", "sps.runs.list",
  "sps.runs.cancel", "sps.runs.listEvents", "sps.artifacts.publish", "sps.artifacts.list",
  "memory.publishLifecycle", "activity.log",
];

export function createSpsWorkspacePluginHostHandlers(input: {
  workspaceId: string;
  pluginId: string;
  manifest: PaperclipPluginManifestV1;
  services: HostServices;
  readConfig: () => Promise<Readonly<Record<string, unknown>>>;
}): WorkerToHostHandlers {
  const { workspaceId, pluginId } = input;
  const handlers = createHostClientHandlers({
    pluginId,
    capabilities: input.manifest.capabilities,
    services: { ...input.services, config: { get: input.readConfig } },
  });
  const scoped: WorkerToHostHandlers = {};
  for (const method of METHODS) {
    const handler = handlers[method] as (params: unknown, context?: WorkerHostCallContext) => Promise<unknown>;
    Object.defineProperty(scoped, method, {
      enumerable: true,
      value: async (params: unknown, context?: WorkerHostCallContext) => {
        const deny = () => new InvocationScopeDeniedError(pluginId, method, "a matching Workspace invocation is required");
        if (context?.invalidInvocationScope || context?.invocationScope?.companyId !== workspaceId) throw deny();
        if (method !== "config.get" && method !== "sps.connectivity.current" && method !== "localFolders.declarations") {
          if (!params || typeof params !== "object" || Array.isArray(params)) throw deny();
          const selected = params as Record<string, unknown>;
          if (method === "entities.upsert") {
            if (selected.scopeKind !== "company" || selected.scopeId !== workspaceId
              || (selected.companyId !== undefined && selected.companyId !== workspaceId)) throw deny();
          } else if (method === "entities.list") {
            if ((selected.scopeKind !== undefined && selected.scopeKind !== "company")
              || (selected.scopeId !== undefined && selected.scopeId !== workspaceId)
              || (selected.companyId !== undefined && selected.companyId !== workspaceId)) throw deny();
          } else if (method.startsWith("state.")) {
            // Instance/project/agent scopes could otherwise reach the shared
            // Host store despite this process having a fixed tenant owner.
            if (selected.scopeKind !== "company" || selected.scopeId !== workspaceId) throw deny();
          } else if (selected.companyId !== workspaceId) throw deny();
        }
        return handler(params, context);
      },
    });
  }
  return Object.freeze(scoped);
}
