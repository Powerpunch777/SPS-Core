import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { PluginPerformActionActorContext } from "@paperclipai/plugin-sdk";

const REQUESTED_PERMISSIONS_PARAM = "__paperclipRequestedPermissions";
export type PluginUiActionPermission = typeof PERMISSION_KEYS[number];

/** Trusted actor data resolved by a Core entry point, never copied from params. */
export type PluginUiActionActor = Readonly<{
  type: "user" | "agent" | "system";
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  companyId: string | null;
  hostAuthority: boolean;
}>;

type AccessService = Readonly<{
  canUser(companyId: string, userId: string | null | undefined, permissionKey: PluginUiActionPermission): Promise<boolean>;
  hasPermission(companyId: string, principalType: "user" | "agent", principalId: string,
    permissionKey: PluginUiActionPermission): Promise<boolean>;
}>;

function exactActor(input: PluginUiActionActor): PluginUiActionActor {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError("Invalid trusted Plugin UI actor.");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  const expected = ["type", "userId", "agentId", "runId", "companyId", "hostAuthority"];
  if (keys.length !== expected.length || keys.some(key => typeof key !== "string" || !expected.includes(key)
    || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))) throw new TypeError("Invalid trusted Plugin UI actor.");
  if (!["user", "agent", "system"].includes(input.type)
    || ![input.userId, input.agentId, input.runId, input.companyId].every(value => value === null || typeof value === "string")
    || typeof input.hostAuthority !== "boolean") throw new TypeError("Invalid trusted Plugin UI actor.");
  return input;
}

/** Shared compatibility layer for the ordinary Plugin UI bridge and trusted Core callers. */
export function createPluginUiActionAuthority(access: AccessService) {
  if (!access || typeof access.canUser !== "function" || typeof access.hasPermission !== "function") {
    throw new TypeError("Invalid Plugin UI action permission service.");
  }

  function requestedPermissions(params: Record<string, unknown> | undefined): PluginUiActionPermission[] {
    const raw = params?.[REQUESTED_PERMISSIONS_PARAM];
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter((permission): permission is PluginUiActionPermission => (
      typeof permission === "string" && (PERMISSION_KEYS as readonly string[]).includes(permission)
    )))];
  }

  async function actorContext(actorInput: PluginUiActionActor,
    requested: readonly PluginUiActionPermission[]): Promise<PluginPerformActionActorContext> {
    const actor = exactActor(actorInput);
    let permissions: PluginUiActionPermission[] = [];
    if (actor.companyId && requested.length > 0) {
      if (actor.hostAuthority) permissions = [...requested];
      else if (actor.type === "user" && actor.userId) {
        const decisions = await Promise.all(requested.map(async permissionKey => ({ permissionKey,
          allowed: await access.canUser(actor.companyId!, actor.userId, permissionKey) })));
        permissions = decisions.filter(decision => decision.allowed).map(decision => decision.permissionKey);
      } else if (actor.type === "agent" && actor.agentId) {
        const decisions = await Promise.all(requested.map(async permissionKey => ({ permissionKey,
          allowed: await access.hasPermission(actor.companyId!, "agent", actor.agentId!, permissionKey) })));
        permissions = decisions.filter(decision => decision.allowed).map(decision => decision.permissionKey);
      }
    }
    const permissionContext = permissions.length ? { permissions } : {};
    if (actor.type === "agent") return { type: "agent", userId: null, agentId: actor.agentId,
      runId: actor.runId, companyId: actor.companyId, ...permissionContext };
    if (actor.type === "user") return { type: "user", userId: actor.userId, agentId: null,
      runId: actor.runId, companyId: actor.companyId, ...permissionContext };
    return { type: "system", userId: null, agentId: null, runId: actor.runId,
      companyId: actor.companyId, ...permissionContext };
  }

  function actionParams(params: Record<string, unknown> | undefined,
    authorizedCompanyId: string | undefined): Record<string, unknown> {
    const { [REQUESTED_PERMISSIONS_PARAM]: _requested, ...base } = params ?? {};
    return authorizedCompanyId === undefined ? base : { ...base, companyId: authorizedCompanyId };
  }

  return Object.freeze({ requestedPermissions, actorContext, actionParams });
}
