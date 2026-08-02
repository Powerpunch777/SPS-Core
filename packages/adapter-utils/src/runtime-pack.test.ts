import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { findAgentRuntimePackCommand, listInstalledAgentRuntimePacks } from "./runtime-pack.js";

async function writePack(root: string, id: string, version: string, command = "bin/agent.cmd") {
  const packRoot = path.join(root, id, version);
  await fs.mkdir(path.join(packRoot, "bin"), { recursive: true });
  await fs.writeFile(path.join(packRoot, command), "@echo off\r\n", "utf8");
  await fs.writeFile(path.join(packRoot, "sps-agent-runtime-pack.json"), JSON.stringify({
    format: 1,
    id,
    version,
    commands: { "example-agent": command },
  }), "utf8");
  return packRoot;
}

test("discovers the newest explicit Agent Runtime pack command", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sps-runtime-pack-"));
  try {
    await writePack(root, "example", "1.0.0");
    const newer = await writePack(root, "example", "1.2.0");
    const packs = await listInstalledAgentRuntimePacks(root);
    expect(packs).toHaveLength(2);
    expect(await findAgentRuntimePackCommand("example-agent", root)).toBe(path.join(newer, "bin", "agent.cmd"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects command paths that escape an Agent Runtime pack", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sps-runtime-pack-"));
  try {
    const packRoot = await writePack(root, "unsafe", "1.0.0", "../outside.cmd");
    await fs.writeFile(path.join(packRoot, "..", "outside.cmd"), "@echo off\r\n", "utf8");
    expect(await findAgentRuntimePackCommand("example-agent", root)).toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
