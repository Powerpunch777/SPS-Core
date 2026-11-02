import { describe, expect, it } from "vitest";
import {
  projectSpsSourceArtifactInventory,
  requireSpsSourceArtifactInventory,
} from "../services/sps-source-artifact-inventory.js";

const at = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const revision = "2026-10-31T12:34:56.789Z";

function source(kind: "workspace" | "project", id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind,
    id,
    workspaceId: at(1),
    resourceId: kind === "workspace" ? id : at(100 + Number.parseInt(id.slice(-4), 16)),
    route: kind === "workspace" ? null : "\\\\files.example\\project-share",
    status: "active",
    revision,
    ...overrides,
  };
}

function grant(
  kind: "workspace" | "project",
  id: string,
  sourceId: string,
  overrides: Record<string, unknown> = {},
) {
  return { kind, id, workspaceId: at(1), sourceId, nodeId: at(50), revokedAt: null, revision, ...overrides };
}

function projected() {
  const workspaceId = at(11), projectId = at(12);
  return projectSpsSourceArtifactInventory({
    sources: [source("project", projectId), source("workspace", workspaceId)],
    grants: [
      grant("project", at(22), projectId, { nodeId: at(52) }),
      grant("workspace", at(21), workspaceId),
    ],
  });
}

function mutableDto() {
  return JSON.parse(JSON.stringify(projected())) as {
    sources: Array<Record<string, unknown>>;
    grants: Array<Record<string, unknown>>;
    fingerprint: string;
  };
}

function expectUnavailable(input: unknown) {
  expect(() => requireSpsSourceArtifactInventory(input)).toThrow(
    expect.objectContaining({ code: "SPS_SOURCE_ARTIFACT_INVENTORY_UNAVAILABLE" }),
  );
}

describe("SPS source artifact inventory DTO validation", () => {
  it("accepts the projected contract, canonicalizes row order, and verifies its fingerprint", () => {
    const dto = mutableDto();
    const result = requireSpsSourceArtifactInventory(dto);
    const reordered = {
      ...dto,
      sources: [...dto.sources].reverse(),
      grants: [...dto.grants].reverse(),
    };

    expect(result).toEqual(projected());
    expect(requireSpsSourceArtifactInventory(reordered)).toEqual(result);
    expect(requireSpsSourceArtifactInventory(reordered).fingerprint).toBe(dto.fingerprint);
    expect(result.sources.map((row) => `${row.kind}:${row.id}`)).toEqual(
      [...result.sources].map((row) => `${row.kind}:${row.id}`).sort(),
    );
  });

  it("returns a deeply frozen clone that does not share mutable input rows", () => {
    const dto = mutableDto();
    const result = requireSpsSourceArtifactInventory(dto);
    const originalId = result.sources[0]!.id;

    expect(result).not.toBe(dto);
    expect(result.sources).not.toBe(dto.sources);
    expect(result.sources[0]).not.toBe(dto.sources[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sources)).toBe(true);
    expect(Object.isFrozen(result.grants)).toBe(true);
    expect(result.sources.every(Object.isFrozen)).toBe(true);
    expect(result.grants.every(Object.isFrozen)).toBe(true);

    dto.sources[0]!.id = at(999);
    dto.grants.splice(0, 1);
    expect(result.sources[0]!.id).toBe(originalId);
    expect(result.grants).toHaveLength(2);
  });

  it("rejects malformed hashes, raw routes, unknown fields, and secret-like fields", () => {
    const badHash = mutableDto();
    badHash.fingerprint = "not-a-sha256-hash";
    expectUnavailable(badHash);

    const wrongHash = mutableDto();
    wrongHash.fingerprint = "0".repeat(64);
    expectUnavailable(wrongHash);

    const rawRoute = mutableDto();
    rawRoute.sources[0]!.routeFingerprint = "\\\\files.example\\private-share";
    expectUnavailable(rawRoute);

    const rootExtra = { ...mutableDto(), credentialEnvelope: "private" };
    expectUnavailable(rootExtra);

    const rowExtra = mutableDto();
    rowExtra.sources[0]!.displayName = "private source";
    expectUnavailable(rowExtra);
  });

  it("rejects duplicate identities, orphaned grants, and parent or Workspace mismatches", () => {
    const duplicateSource = mutableDto();
    duplicateSource.sources.push({ ...duplicateSource.sources[0] });
    expectUnavailable(duplicateSource);

    const duplicateGrant = mutableDto();
    duplicateGrant.grants.push({ ...duplicateGrant.grants[0] });
    expectUnavailable(duplicateGrant);

    const orphan = mutableDto();
    orphan.grants[0]!.sourceId = at(900);
    expectUnavailable(orphan);

    const foreignWorkspace = mutableDto();
    foreignWorkspace.grants[0]!.workspaceId = at(901);
    expectUnavailable(foreignWorkspace);

    const foreignParent = mutableDto();
    foreignParent.grants[0]!.kind = "workspace";
    expectUnavailable(foreignParent);
  });

  it("accepts only canonical ISO date strings, not Date objects or noncanonical forms", () => {
    const dateObject = mutableDto();
    dateObject.sources[0]!.revision = new Date(revision);
    expectUnavailable(dateObject);

    for (const invalid of ["2026-10-31T12:34:56Z", "2026-02-30T12:34:56.789Z", "2026-10-31T12:34:56.789+00:00"]) {
      const dto = mutableDto();
      dto.grants[0]!.revokedAt = invalid;
      expectUnavailable(dto);
    }
  });

  it("rejects accessors without invoking them and rejects sparse arrays", () => {
    const dto = mutableDto();
    let getterCalled = false;
    Object.defineProperty(dto.sources[0]!, "status", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "active";
      },
    });
    expectUnavailable(dto);
    expect(getterCalled).toBe(false);

    const sparse = mutableDto();
    sparse.sources = new Array(1);
    expectUnavailable(sparse);
  });

  it("enforces the source and grant row limits", () => {
    const tooManySources = {
      sources: Array.from({ length: 4097 }, (_, index) => ({
        kind: "workspace", id: at(10_000 + index), workspaceId: at(1),
        resourceId: at(10_000 + index), routeFingerprint: null, status: "active", revision,
      })),
      grants: [], fingerprint: "0".repeat(64),
    };
    expectUnavailable(tooManySources);

    const sourceId = at(20_000);
    const tooManyGrants = {
      sources: [{
        kind: "workspace", id: sourceId, workspaceId: at(1), resourceId: sourceId,
        routeFingerprint: null, status: "active", revision,
      }],
      grants: Array.from({ length: 16_385 }, (_, index) => ({
        kind: "workspace", id: at(30_000 + index), workspaceId: at(1), sourceId,
        nodeId: at(50_000 + index), revokedAt: null, revision,
      })),
      fingerprint: "0".repeat(64),
    };
    expectUnavailable(tooManyGrants);
  });
});
