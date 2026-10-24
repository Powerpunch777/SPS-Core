import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStaticUiDist } from "../static-ui-dist.js";

describe("static UI distribution source", () => {
  const root = path.resolve("fixture-core");
  const directory = path.join(root, "server", "dist");
  const packaged = path.join(root, "server", "ui-dist");
  const source = path.join(root, "ui", "dist");
  const workspace = [path.join(root, "pnpm-workspace.yaml"), path.join(root, "ui", "package.json")];
  const existsFor = (files: string[]) => (file: string) => files.includes(file);

  it("uses the current source UI even when a stale packaging copy exists", () => {
    expect(resolveStaticUiDist(directory, existsFor([...workspace, path.join(packaged, "index.html"), path.join(source, "index.html")]))).toBe(source);
  });
  it("does not fall back to stale packaged assets in an unbuilt source checkout", () => {
    expect(resolveStaticUiDist(directory, existsFor([...workspace, path.join(packaged, "index.html")]))).toBeUndefined();
  });
  it("uses packaged assets outside a source workspace", () => {
    expect(resolveStaticUiDist(directory, existsFor([path.join(packaged, "index.html"), path.join(source, "index.html")]))).toBe(packaged);
  });
  it("does not treat a loose sibling UI folder as a source checkout", () => {
    expect(resolveStaticUiDist(directory, existsFor([path.join(source, "index.html")]))).toBeUndefined();
  });
});
