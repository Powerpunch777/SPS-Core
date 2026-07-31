import { createHash } from "node:crypto";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

export type PluginDependencyIssueCode = "MISSING_REQUIRED" | "REQUIRED_VERSION_INCOMPATIBLE" | "CONFLICT" | "CYCLE";

export interface PluginDependencyCandidate {
  id: string;
  version: string;
  manifest: PaperclipPluginManifestV1;
  /** Host lifecycle availability. A Company intent cannot override this. */
  available?: boolean;
  active: boolean;
}

export interface PluginDependencyIssue {
  code: PluginDependencyIssueCode;
  pluginId: string;
  dependencyId?: string;
  conflictPluginId?: string;
  actualVersion?: string;
  minVersion?: string;
  maxVersion?: string;
  cycle?: string[];
}

export interface PluginDependencyOptionalStatus {
  pluginId: string;
  dependencyId?: string;
  service?: string;
  status: "available" | "incompatible" | "missing";
  providers: string[];
}

export interface PluginDependencyReport {
  schemaVersion: "sps-plugin-dependency/v1";
  status: "ready" | "blocked";
  issues: PluginDependencyIssue[];
  optionalDependencies: PluginDependencyOptionalStatus[];
  blockedPluginIds: string[];
  impact: { action: "disable" | "delete"; pluginId: string; affectedPluginIds: string[]; reviewId: string } | null;
  recovery: string[];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Precision-safe SemVer precedence comparison. Build metadata is ignored. */
export function comparePluginDependencyVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = SEMVER.exec(value);
    if (!match) throw new Error(`Invalid SemVer version: ${value}`);
    return { core: [match[1]!, match[2]!, match[3]!], prerelease: match[4]?.split(".") ?? [] };
  };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const result = compareNumeric(a.core[index]!, b.core[index]!);
    if (result !== 0) return result;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]; const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart); const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumeric(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function matchesRange(version: string, declaration: { minVersion?: string; maxVersion?: string }): boolean {
  return (!declaration.minVersion || comparePluginDependencyVersions(version, declaration.minVersion) >= 0)
    && (!declaration.maxVersion || comparePluginDependencyVersions(version, declaration.maxVersion) <= 0);
}

function manifestId(plugin: PluginDependencyCandidate): string {
  return plugin.manifest.id;
}

function dependencyId(plugin: PluginDependencyCandidate): string {
  return manifestId(plugin);
}

function findCycles(plugins: Map<string, PluginDependencyCandidate>): string[][] {
  const cycles = new Map<string, string[]>(); const visited = new Set<string>(); const visiting = new Set<string>(); const path: string[] = [];
  const visit = (id: string) => {
    if (visiting.has(id)) {
      const cycle = path.slice(path.indexOf(id));
      const first = cycle.reduce((best, value, index) => value < cycle[best]! ? index : best, 0);
      const normalized = [...cycle.slice(first), ...cycle.slice(0, first), cycle[first]!];
      cycles.set(normalized.join("\u0000"), normalized);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id); visiting.add(id); path.push(id);
    for (const dependency of plugins.get(id)!.manifest.requiredDependencies ?? []) if (plugins.has(dependency.id)) visit(dependency.id);
    path.pop(); visiting.delete(id);
  };
  for (const id of [...plugins.keys()].sort()) visit(id);
  return [...cycles.values()].sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")));
}

function impactedDependents(plugins: PluginDependencyCandidate[], targetId: string): string[] {
  const reverse = new Map<string, string[]>();
  for (const plugin of plugins.filter((candidate) => candidate.active)) for (const dependency of plugin.manifest.requiredDependencies ?? []) {
    reverse.set(dependency.id, [...(reverse.get(dependency.id) ?? []), dependencyId(plugin)]);
  }
  const affected = new Set<string>(); const queue = [...(reverse.get(targetId) ?? [])].sort();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (affected.has(id)) continue;
    affected.add(id); queue.push(...(reverse.get(id) ?? []).sort());
  }
  return [...affected].sort();
}

export function analyzePluginDependencies(
  candidates: PluginDependencyCandidate[],
  target?: { action: "enable" | "disable" | "delete"; pluginId: string },
): PluginDependencyReport {
  const active = new Map<string, PluginDependencyCandidate>();
  for (const candidate of candidates) {
    const id = dependencyId(candidate);
    const enabled = target?.pluginId === id
      ? target.action === "enable" && candidate.available !== false
      : candidate.active;
    if (enabled) active.set(id, candidate);
  }
  const issues: PluginDependencyIssue[] = [];
  const optionalDependencies: PluginDependencyOptionalStatus[] = [];
  const providers = new Map<string, PluginDependencyCandidate[]>();
  for (const plugin of active.values()) for (const service of plugin.manifest.services ?? []) providers.set(service.id, [...(providers.get(service.id) ?? []), plugin]);
  for (const [id, plugin] of active) {
    for (const dependency of plugin.manifest.requiredDependencies ?? []) {
      const candidate = active.get(dependency.id);
      if (!candidate) issues.push({ code: "MISSING_REQUIRED", pluginId: id, dependencyId: dependency.id });
      else if (!matchesRange(candidate.version, dependency)) issues.push({ code: "REQUIRED_VERSION_INCOMPATIBLE", pluginId: id, dependencyId: dependency.id, actualVersion: candidate.version, minVersion: dependency.minVersion, maxVersion: dependency.maxVersion });
    }
    for (const optional of plugin.manifest.optionalDependencies ?? []) {
      const matches = optional.id ? [active.get(optional.id)].filter((value): value is PluginDependencyCandidate => Boolean(value)) : (providers.get(optional.service!) ?? []);
      const compatible = matches.filter((candidate) => matchesRange(candidate.version, optional)).map(dependencyId).sort();
      optionalDependencies.push({ pluginId: id, ...(optional.id ? { dependencyId: optional.id } : { service: optional.service }), status: compatible.length ? "available" : matches.length ? "incompatible" : "missing", providers: compatible });
    }
    for (const conflict of plugin.manifest.conflicts ?? []) {
      const candidate = active.get(conflict.id);
      if (candidate && matchesRange(candidate.version, conflict)) issues.push({ code: "CONFLICT", pluginId: id, conflictPluginId: conflict.id, actualVersion: candidate.version, minVersion: conflict.minVersion, maxVersion: conflict.maxVersion });
    }
  }
  for (const cycle of findCycles(active)) issues.push({ code: "CYCLE", pluginId: cycle[0]!, cycle });
  issues.sort((a, b) => `${a.pluginId}\u0000${a.code}\u0000${a.dependencyId ?? a.conflictPluginId ?? ""}`.localeCompare(`${b.pluginId}\u0000${b.code}\u0000${b.dependencyId ?? b.conflictPluginId ?? ""}`));
  optionalDependencies.sort((a, b) => `${a.pluginId}\u0000${a.dependencyId ?? a.service}`.localeCompare(`${b.pluginId}\u0000${b.dependencyId ?? b.service}`));
  const blocked = new Set(issues.flatMap((issue) => {
    if (issue.code === "CYCLE") return issue.cycle ?? [];
    // A declared conflict makes the pair mutually unavailable. Otherwise a
    // newly-enabled target could succeed while only the already-active
    // declarer is marked blocked.
    if (issue.code === "CONFLICT") return [issue.pluginId, issue.conflictPluginId!];
    return [issue.pluginId];
  }));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, plugin] of active) if (!blocked.has(id) && (plugin.manifest.requiredDependencies ?? []).some((dependency) => blocked.has(dependency.id))) {
      blocked.add(id); changed = true;
    }
  }
  const impact = target && (target.action === "disable" || target.action === "delete")
    ? (() => {
      const affectedPluginIds = impactedDependents(candidates, target.pluginId);
      const stable = JSON.stringify({ action: target.action, pluginId: target.pluginId, affectedPluginIds });
      return { action: target.action, pluginId: target.pluginId, affectedPluginIds, reviewId: createHash("sha256").update(stable).digest("hex").slice(0, 24) };
    })()
    : null;
  const recovery = [...new Set([
    ...issues.filter((issue) => issue.code === "MISSING_REQUIRED").map((issue) => `Make required plugin ${issue.dependencyId} ready and enabled.`),
    ...issues.filter((issue) => issue.code === "REQUIRED_VERSION_INCOMPATIBLE").map((issue) => `Use a compatible version of ${issue.dependencyId}.`),
    ...issues.filter((issue) => issue.code === "CONFLICT").map((issue) => `Disable or reconfigure conflicting plugin ${issue.conflictPluginId}.`),
    ...issues.filter((issue) => issue.code === "CYCLE").map(() => "Remove at least one required dependency from the cycle."),
    ...(impact?.affectedPluginIds.length ? ["Review the reported dependent plugins and repeat the mutation with impactReviewId."] : []),
  ])].sort();
  return { schemaVersion: "sps-plugin-dependency/v1", status: issues.length === 0 ? "ready" : "blocked", issues, optionalDependencies, blockedPluginIds: [...blocked].sort(), impact, recovery };
}

export function isPluginDependencyAvailable(report: PluginDependencyReport, pluginId: string): boolean {
  return !report.blockedPluginIds.includes(pluginId);
}
