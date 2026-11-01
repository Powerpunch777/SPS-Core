import { createHash } from "node:crypto";
import type { Db } from "../compat/paperclip/db.js";
import { spsHostProjectShares, spsHostProjectShareNodeGrants, spsWorkspaceSources,
  spsWorkspaceSourceNodeGrants } from "../compat/paperclip/db.js";

const MAX_SOURCES = 4096;
const MAX_GRANTS = 16384;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
type Kind = "workspace" | "project";
export type SpsSourceArtifactInventory = Readonly<{
  sources: readonly Readonly<{ kind: Kind; id: string; workspaceId: string; resourceId: string;
    status: string; routeFingerprint: string | null; revision: string }>[];
  grants: readonly Readonly<{ kind: Kind; id: string; workspaceId: string; sourceId: string;
    nodeId: string; revokedAt: string | null; revision: string }>[];
  fingerprint: string;
}>;

export class SpsSourceArtifactInventoryUnavailableError extends Error {
  readonly code = "SPS_SOURCE_ARTIFACT_INVENTORY_UNAVAILABLE";
  constructor() { super("Source artifact inventory is unavailable; preserve all package files."); }
}
const fail = (): never => { throw new SpsSourceArtifactInventoryUnavailableError(); };
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length
    || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]))) return fail();
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}
function rows(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_, index) => {
    if (!fields[index]?.enumerable || !("value" in fields[index])) return fail();
    return fields[index].value;
  });
}
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return fail();
  return value;
}
function kind(value: unknown): Kind {
  if (value !== "workspace" && value !== "project") return fail();
  return value;
}
function date(value: unknown): string {
  if (value instanceof Date && Object.getPrototypeOf(value) === Date.prototype
    && Reflect.ownKeys(value).length === 0 && Number.isFinite(Date.prototype.getTime.call(value))) {
    return Date.prototype.toISOString.call(value);
  }
  if (typeof value !== "string" || value.length !== 24) return fail();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return fail();
  return value;
}
function routeFingerprint(value: unknown): string | null {
  if (value === null) return null;
  // A transport identity only, never resolve UNC paths or contact an SMB server.
  if (typeof value !== "string" || value.length > 4096
    || !/^\\\\[^\\/\s\u0000-\u001f\u007f]+\\[^\\/\s\u0000-\u001f\u007f]+$/.test(value)
    || value.includes("\uFFFD") || value.split("\\").some(part => part === "." || part === "..")) return fail();
  const [, , hostname, share] = value.split("\\");
  if (hostname.length > 253 || hostname.split(".").some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/.test(label))
    || !/^[A-Za-z0-9][A-Za-z0-9._$-]{0,254}$/.test(share)) return fail();
  return hash(value.toLowerCase());
}

/** Private declarative inventory: no display names, routes, credentials or local paths escape. */
export function projectSpsSourceArtifactInventory(input: unknown): SpsSourceArtifactInventory {
  try {
    const root = record(input, ["sources", "grants"]);
    const sourceIds = new Map<string, string>(), resources = new Set<string>();
    const sources = rows(root.sources, MAX_SOURCES).map(value => {
      const row = record(value, ["kind", "id", "workspaceId", "resourceId", "route", "status", "revision"]);
      const category = kind(row.kind), sourceId = id(row.id), workspaceId = id(row.workspaceId), resourceId = id(row.resourceId);
      const key = `${category}:${sourceId}`, resourceKey = `${category}:${workspaceId}:${resourceId}`;
      if (sourceIds.has(key) || resources.has(resourceKey) || category === "workspace" && sourceId !== resourceId
        || typeof row.status !== "string" || !row.status || row.status.length > 64 || /[\u0000-\u001f\u007f\uFFFD]/.test(row.status)) return fail();
      const route = routeFingerprint(row.route);
      if (category === "project" && route === null) return fail();
      sourceIds.set(key, workspaceId); resources.add(resourceKey);
      return Object.freeze({ kind: category, id: sourceId, workspaceId, resourceId,
        status: row.status, routeFingerprint: route, revision: date(row.revision) });
    });
    const grantIds = new Set<string>(), grantTargets = new Set<string>();
    const grants = rows(root.grants, MAX_GRANTS).map(value => {
      const row = record(value, ["kind", "id", "workspaceId", "sourceId", "nodeId", "revokedAt", "revision"]);
      const category = kind(row.kind), grantId = id(row.id), workspaceId = id(row.workspaceId), sourceId = id(row.sourceId), nodeId = id(row.nodeId);
      const key = `${category}:${grantId}`, target = `${category}:${sourceId}:${nodeId}`;
      if (grantIds.has(key) || grantTargets.has(target) || sourceIds.get(`${category}:${sourceId}`) !== workspaceId) return fail();
      grantIds.add(key); grantTargets.add(target);
      return Object.freeze({ kind: category, id: grantId, workspaceId, sourceId, nodeId,
        revokedAt: row.revokedAt === null ? null : date(row.revokedAt), revision: date(row.revision) });
    });
    sources.sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
    grants.sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
    const serialized = JSON.stringify([sources, grants]);
    if (Buffer.byteLength(serialized, "utf8") > 6 * 1024 * 1024) return fail();
    return Object.freeze({ sources: Object.freeze(sources), grants: Object.freeze(grants), fingerprint: hash(serialized) });
  } catch { return fail(); }
}

/** All retained Workspaces, including disabled sources and revoked grants. Read-only and bounded. */
export async function readSpsSourceArtifactInventory(db: Db): Promise<SpsSourceArtifactInventory> {
  try {
    return await db.transaction(async tx => {
      const workspace = await tx.select({ id: spsWorkspaceSources.id, workspaceId: spsWorkspaceSources.companyId,
        resourceId: spsWorkspaceSources.id, route: spsWorkspaceSources.sharePath,
        status: spsWorkspaceSources.status, revision: spsWorkspaceSources.updatedAt })
        .from(spsWorkspaceSources).limit(MAX_SOURCES + 1);
      const project = await tx.select({ id: spsHostProjectShares.id, workspaceId: spsHostProjectShares.companyId,
        resourceId: spsHostProjectShares.projectId, route: spsHostProjectShares.sharePath,
        status: spsHostProjectShares.status, revision: spsHostProjectShares.updatedAt })
        .from(spsHostProjectShares).limit(MAX_SOURCES + 1);
      const sourceGrants = await tx.select({ id: spsWorkspaceSourceNodeGrants.id, workspaceId: spsWorkspaceSourceNodeGrants.companyId,
        sourceId: spsWorkspaceSourceNodeGrants.sourceId, nodeId: spsWorkspaceSourceNodeGrants.nodeId,
        revokedAt: spsWorkspaceSourceNodeGrants.revokedAt, revision: spsWorkspaceSourceNodeGrants.updatedAt })
        .from(spsWorkspaceSourceNodeGrants).limit(MAX_GRANTS + 1);
      const projectGrants = await tx.select({ id: spsHostProjectShareNodeGrants.id, workspaceId: spsHostProjectShareNodeGrants.companyId,
        sourceId: spsHostProjectShareNodeGrants.shareId, nodeId: spsHostProjectShareNodeGrants.nodeId,
        revokedAt: spsHostProjectShareNodeGrants.revokedAt, revision: spsHostProjectShareNodeGrants.updatedAt })
        .from(spsHostProjectShareNodeGrants).limit(MAX_GRANTS + 1);
      return projectSpsSourceArtifactInventory({ sources: [...workspace.map(row => ({ kind: "workspace", ...row })),
        ...project.map(row => ({ kind: "project", ...row }))], grants: [...sourceGrants.map(row => ({ kind: "workspace", ...row })),
        ...projectGrants.map(row => ({ kind: "project", ...row }))] });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch { return fail(); }
}
