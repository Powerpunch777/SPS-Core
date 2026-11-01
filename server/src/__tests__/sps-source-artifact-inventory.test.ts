import { describe, expect, it } from "vitest";
import { projectSpsSourceArtifactInventory } from "../services/sps-source-artifact-inventory.js";

const at = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const revision = "2026-10-31T12:34:56.789Z";

function workspaceSource(id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "workspace",
    id,
    workspaceId: at(1),
    resourceId: id,
    route: null,
    status: "active",
    revision,
    ...overrides,
  };
}

function projectSource(id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "project",
    id,
    workspaceId: at(1),
    resourceId: at(100 + Number.parseInt(id.slice(-4), 16)),
    route: "\\\\files.example\\project-share",
    status: "active",
    revision,
    ...overrides,
  };
}

function grant(id: string, sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "workspace",
    id,
    workspaceId: at(1),
    sourceId,
    nodeId: at(50),
    revokedAt: null,
    revision,
    ...overrides,
  };
}

function inventory(sources: unknown[] = [], grants: unknown[] = []) {
  return projectSpsSourceArtifactInventory({ sources, grants });
}

function expectUnavailable(input: unknown) {
  let error: unknown;
  try {
    projectSpsSourceArtifactInventory(input);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: "SPS_SOURCE_ARTIFACT_INVENTORY_UNAVAILABLE" });
  expect((error as Error).message).toBe("Source artifact inventory is unavailable; preserve all package files.");
}

describe("SPS source artifact inventory projection", () => {
  it("projects an empty inventory", () => {
    expect(inventory()).toMatchObject({ sources: [], grants: [], fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("retains every status and revoked grant with normalized dates", () => {
    const sourceId = at(10);
    const result = inventory([
      workspaceSource(sourceId, { status: "disabled", revision: new Date(revision) }),
      projectSource(at(11), { status: "pending", revision }),
    ], [
      grant(at(12), sourceId, { revokedAt: new Date(revision), revision: new Date(revision) }),
    ]);

    expect(result.sources.map(({ status }) => status)).toEqual(["pending", "disabled"]);
    expect(result.grants).toEqual([{
      kind: "workspace",
      id: at(12),
      workspaceId: at(1),
      sourceId,
      nodeId: at(50),
      revokedAt: revision,
      revision,
    }]);
  });

  it("keeps identical resources isolated across Workspaces", () => {
    const projectId = at(30);
    const sources = [
      projectSource(at(31), { workspaceId: at(1), resourceId: projectId }),
      projectSource(at(32), { workspaceId: at(2), resourceId: projectId }),
    ];
    const grants = [
      grant(at(33), at(31), { kind: "project", workspaceId: at(1) }),
      grant(at(34), at(32), { kind: "project", workspaceId: at(2) }),
    ];

    expect(inventory(sources, grants).sources).toHaveLength(2);
    expect(inventory(sources, grants).grants).toHaveLength(2);
  });

  it("sorts deterministically and deeply freezes the projection", () => {
    const a = workspaceSource(at(41));
    const b = projectSource(at(42));
    const ga = grant(at(43), at(41));
    const gb = grant(at(44), at(42), { kind: "project" });
    const first = inventory([b, a], [gb, ga]);
    const reordered = inventory([a, b], [ga, gb]);

    expect(first).toEqual(reordered);
    expect(first.sources.map(({ id }) => id)).toEqual([at(42), at(41)]);
    expect(first.grants.map(({ id }) => id)).toEqual([at(44), at(43)]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sources)).toBe(true);
    expect(Object.isFrozen(first.grants)).toBe(true);
    expect(first.sources.every(Object.isFrozen)).toBe(true);
    expect(first.grants.every(Object.isFrozen)).toBe(true);
  });

  it("changes the fingerprint when route, status, revision, or revocation changes", () => {
    const sourceId = at(51);
    const source = workspaceSource(sourceId, { route: "\\\\host.example\\share" });
    const grantRow = grant(at(52), sourceId);
    const baseline = inventory([source], [grantRow]).fingerprint;
    const variants = [
      inventory([{ ...source, route: "\\\\host.example\\other" }], [grantRow]),
      inventory([{ ...source, status: "offline" }], [grantRow]),
      inventory([{ ...source, revision: "2026-11-01T12:34:56.789Z" }], [grantRow]),
      inventory([source], [grant(at(52), sourceId, { revokedAt: revision })]),
    ];

    for (const variant of variants) expect(variant.fingerprint).not.toBe(baseline);
  });

  it("never exposes route text, share names, credentials, or display names", () => {
    const route = "\\\\host.example\\confidential-share";
    const result = inventory([
      workspaceSource(at(61), { route }),
      projectSource(at(62), { route: "\\\\host.example\\customer-project" }),
    ]);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(route);
    expect(serialized).not.toContain("confidential-share");
    expect(serialized).not.toContain("customer-project");
    expect(serialized).not.toContain("credentialEnvelope");
    expect(serialized).not.toContain("displayName");
    expect(result.sources.every(({ routeFingerprint }) => /^[a-f0-9]{64}$/.test(routeFingerprint ?? ""))).toBe(true);
  });

  it("rejects duplicate source ids and duplicate project resources per Workspace", () => {
    const sourceId = at(71);
    expectUnavailable({ sources: [workspaceSource(sourceId), workspaceSource(sourceId)], grants: [] });
    expectUnavailable({
      sources: [
        projectSource(at(74), { resourceId: at(75) }),
        projectSource(at(76), { resourceId: at(75) }),
      ],
      grants: [],
    });
  });

  it("rejects duplicate grants, orphan grants, and cross-Workspace grants", () => {
    const sourceId = at(81);
    const source = workspaceSource(sourceId);
    expectUnavailable({ sources: [source], grants: [grant(at(82), sourceId), grant(at(83), sourceId)] });
    expectUnavailable({ sources: [source], grants: [grant(at(84), at(85))] });
    expectUnavailable({ sources: [source], grants: [grant(at(86), sourceId, { workspaceId: at(2) })] });

    const secondSourceId = at(87);
    expectUnavailable({
      sources: [source, workspaceSource(secondSourceId)],
      grants: [
        grant(at(88), sourceId, { nodeId: at(89) }),
        grant(at(88), secondSourceId, { nodeId: at(90) }),
      ],
    });
  });

  it("rejects malformed dates and invalid routes", () => {
    const sourceId = at(91);
    expectUnavailable({ sources: [workspaceSource(sourceId, { revision: "2026-02-30T12:00:00.000Z" })], grants: [] });
    expectUnavailable({ sources: [workspaceSource(sourceId, { revision: new Date(Number.NaN) })], grants: [] });
    expectUnavailable({ sources: [workspaceSource(sourceId, { revision: "2026-10-31T12:34:56Z" })], grants: [] });
    expectUnavailable({ sources: [workspaceSource(sourceId, { route: "C:\\private\\local" })], grants: [] });
    expectUnavailable({ sources: [workspaceSource(sourceId, { route: "\\\\host.example" })], grants: [] });
    expectUnavailable({ sources: [workspaceSource(sourceId, { route: "\\\\host.example\\share\\child" })], grants: [] });
    expectUnavailable({ sources: [projectSource(at(92), { route: null })], grants: [] });
    expectUnavailable({ sources: [workspaceSource(at(93))], grants: [grant(at(94), at(93), { revokedAt: "not-a-date" })] });
  });

  it("rejects malformed UUIDs, source kinds, and unknown root fields", () => {
    expectUnavailable({ sources: [workspaceSource("not-a-uuid", { resourceId: "not-a-uuid" })], grants: [] });
    expectUnavailable({ sources: [workspaceSource(at(95), { kind: "other" })], grants: [] });
    expectUnavailable({ sources: [], grants: [], credentialEnvelope: "private" });
  });

  it("rejects credentials in the UNC authority", () => {
    expectUnavailable({ sources: [workspaceSource(at(101), { route: "\\\\user:secret@host.example\\share" })], grants: [] });
  });

  it("rejects input fields outside the contract", () => {
    expectUnavailable({ sources: [workspaceSource(at(102), { displayName: "private source name" })], grants: [] });
    expectUnavailable({ sources: [], grants: [{ ...grant(at(103), at(104)), credentialEnvelope: "secret" }] });
  });

  it("rejects accessors and sparse arrays without evaluating getters", () => {
    let called = false;
    const accessor = Object.defineProperty(workspaceSource(at(111)), "status", {
      enumerable: true,
      get() {
        called = true;
        return "active";
      },
    });
    expectUnavailable({ sources: [accessor], grants: [] });
    expect(called).toBe(false);

    const sparse = new Array(1);
    expectUnavailable({ sources: sparse, grants: [] });
  });

  it("rejects source, grant, and per-route size limits", () => {
    const tooManySources = Array.from({ length: 4097 }, (_, index) =>
      workspaceSource(at(10_000 + index)));
    const tooManyGrants = Array.from({ length: 16_385 }, (_, index) =>
      grant(at(30_000 + index), at(40_000 + index)));
    expectUnavailable({ sources: tooManySources, grants: [] });
    expectUnavailable({ sources: [], grants: tooManyGrants });

    const tooLongRoute = `\\\\${"h".repeat(2040)}\\${"s".repeat(2054)}`;
    expectUnavailable({ sources: [workspaceSource(at(50_000), { route: tooLongRoute })], grants: [] });
  });
});
