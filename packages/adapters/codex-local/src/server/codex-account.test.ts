import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";
import {
  listLocalCodexAccountOptions,
  resolveSelectedCodexHome,
} from "./codex-account.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-accounts-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Codex account configuration", () => {
  it("lists only signed-in local Codex profiles with the default first", async () => {
    const root = await makeTempRoot();
    await fs.mkdir(path.join(root, ".codex"));
    await fs.writeFile(path.join(root, ".codex", "auth.json"), "{}", "utf8");
    await fs.mkdir(path.join(root, ".codex-plus-b"));
    await fs.writeFile(path.join(root, ".codex-plus-b", "auth.json"), "{}", "utf8");
    await fs.mkdir(path.join(root, ".codex-no-auth"));
    await fs.mkdir(path.join(root, ".not-codex"));
    await fs.writeFile(path.join(root, ".not-codex", "auth.json"), "{}", "utf8");

    expect(listLocalCodexAccountOptions(root)).toEqual([
      { value: ".codex", label: "Default Codex account" },
      { value: ".codex-plus-b", label: "Plus B Codex account" },
    ]);
    const accountField = getConfigSchema(root).fields.find((field) => field.key === "codexAccount");
    expect(accountField?.type).toBe("select");
    expect(accountField?.options).toHaveLength(2);
  });

  it("resolves approved profile directory names and rejects path traversal", async () => {
    const root = await makeTempRoot();
    expect(resolveSelectedCodexHome(".codex-plus-b", root)).toBe(path.join(root, ".codex-plus-b"));
    expect(resolveSelectedCodexHome("", root)).toBeNull();
    expect(() => resolveSelectedCodexHome("../other", root)).toThrow("profile directory name");
    expect(() => resolveSelectedCodexHome(".codex/other", root)).toThrow("profile directory name");
  });
});
