import { describe, expect, it } from "vitest";
import {
  applyUiBranding,
  getWorktreeUiBranding,
  isSpsBasicModeEnabled,
  isSpsCoreBaselineModeEnabled,
  isWorkplaneModeEnabled,
  isWorktreeUiBrandingEnabled,
  renderFaviconLinks,
  renderRuntimeBrandingMeta,
  renderSpsBasicModeMeta,
  renderSpsCoreBaselineModeMeta,
  renderWorkplaneModeMeta,
} from "../ui-branding.js";

const TEMPLATE = `<!doctype html>
<head>
    <!-- SPS_RUNTIME_BRANDING_START -->
    <!-- SPS_RUNTIME_BRANDING_END -->
    <!-- SPS_FAVICON_START -->
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <!-- SPS_FAVICON_END -->
</head>`;

describe("ui branding", () => {
  it("detects worktree mode from PAPERCLIP_IN_WORKTREE", () => {
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "true" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "1" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PAPERCLIP_IN_WORKTREE: "false" })).toBe(false);
  });

  it("surfaces workplane mode independently from worktree branding", () => {
    expect(isWorkplaneModeEnabled({ SPS_WORKPLANE_MODE: "true" })).toBe(true);
    expect(isWorkplaneModeEnabled({ SPS_WORKPLANE_MODE: "false" })).toBe(false);
    expect(renderWorkplaneModeMeta({
      SPS_WORKPLANE_MODE: "1",
      SPS_WORKPLANE_ROOM_ORIGIN_PREFIXES: "plugin:example.rooms:agent-room",
      SPS_WORKPLANE_DEFAULT_PROJECT_TAB: "plugin:example.rooms:project-workplane",
    })).toContain(
      'name="sps-workplane-mode"',
    );

    const branded = applyUiBranding(TEMPLATE, {
      SPS_WORKPLANE_MODE: "true",
      SPS_WORKPLANE_ROOM_ORIGIN_PREFIXES: "plugin:example.rooms:agent-room",
      SPS_WORKPLANE_DEFAULT_PROJECT_TAB: "plugin:example.rooms:project-workplane",
    });
    expect(branded).toContain('<meta name="sps-workplane-mode" content="true" />');
    expect(branded).toContain('name="sps-workplane-room-origin-prefixes"');
    expect(branded).toContain('name="sps-workplane-default-project-tab"');
    expect(branded).toContain('href="/favicon.svg"');
  });

  it("marks the SPS Desktop basic workspace without changing the generic Core default", () => {
    expect(isSpsBasicModeEnabled({ SPS_BASIC_MODE: "true" })).toBe(true);
    expect(isSpsBasicModeEnabled({ SPS_BASIC_MODE: "false" })).toBe(false);
    expect(renderSpsBasicModeMeta({ SPS_BASIC_MODE: "1" })).toContain('name="sps-basic-mode"');

    const branded = applyUiBranding(TEMPLATE, { SPS_BASIC_MODE: "true" });
    expect(branded).toContain('<meta name="sps-basic-mode" content="true" />');
    expect(applyUiBranding(TEMPLATE, {})).not.toContain('name="sps-basic-mode"');
  });

  it("marks a fresh SPS plugin-first Workspace independently from basic mode", () => {
    expect(isSpsCoreBaselineModeEnabled({ SPS_CORE_BASELINE_MODE: "true" })).toBe(true);
    expect(isSpsCoreBaselineModeEnabled({ SPS_CORE_BASELINE_MODE: "false" })).toBe(false);
    expect(renderSpsCoreBaselineModeMeta({ SPS_CORE_BASELINE_MODE: "1" }))
      .toContain('name="sps-core-baseline-mode"');

    const branded = applyUiBranding(TEMPLATE, { SPS_CORE_BASELINE_MODE: "true" });
    expect(branded).toContain('<meta name="sps-core-baseline-mode" content="true" />');
    expect(applyUiBranding(TEMPLATE, {})).not.toContain('name="sps-core-baseline-mode"');
  });

  it("resolves name, color, and text color for worktree branding", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });

    expect(branding.enabled).toBe(true);
    expect(branding.name).toBe("paperclip-pr-432");
    expect(branding.color).toBe("#4f86f7");
    expect(branding.textColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(branding.faviconHref).toContain("data:image/svg+xml,");
  });

  it("renders a dynamic worktree favicon when enabled", () => {
    const links = renderFaviconLinks(
      getWorktreeUiBranding({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
        PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(links).toContain("data:image/svg+xml,");
    expect(links).toContain('rel="shortcut icon"');
  });

  it("renders runtime branding metadata for the ui", () => {
    const meta = renderRuntimeBrandingMeta(
      getWorktreeUiBranding({
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
        PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(meta).toContain('name="sps-worktree-name"');
    expect(meta).toContain('content="paperclip-pr-432"');
    expect(meta).toContain('name="sps-worktree-color"');
  });

  it("surfaces the runtime instance id so the UI can fail closed on copied rows", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
      PAPERCLIP_INSTANCE_ID: "inst-abc123",
    });
    expect(branding.instanceId).toBe("inst-abc123");

    const meta = renderRuntimeBrandingMeta(branding);
    expect(meta).toContain('name="sps-instance-id"');
    expect(meta).toContain('content="inst-abc123"');
  });

  it("omits the instance-id meta when the runtime id is unset", () => {
    const branding = getWorktreeUiBranding({
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branding.instanceId).toBeNull();
    expect(renderRuntimeBrandingMeta(branding)).not.toContain('name="sps-instance-id"');
  });

  it("rewrites the favicon and runtime branding blocks for worktree instances only", () => {
    const branded = applyUiBranding(TEMPLATE, {
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREE_NAME: "paperclip-pr-432",
      PAPERCLIP_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branded).toContain("data:image/svg+xml,");
    expect(branded).toContain('name="sps-worktree-name"');
    expect(branded).not.toContain('href="/favicon.svg"');

    const defaultHtml = applyUiBranding(TEMPLATE, {});
    expect(defaultHtml).toContain('href="/favicon.svg"');
    expect(defaultHtml).not.toContain('name="sps-worktree-name"');
  });
});
