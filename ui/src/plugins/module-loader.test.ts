// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyJsxRuntimeKey, createPluginModuleLoader, createReactShimSource } from "./module-loader";

describe("Plugin UI module loader", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rewrites current SDK, legacy SDK, React, React DOM, and JSX runtime aliases", () => {
    const created: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:module-loader-${created.length}`;
      created.push(url);
      return url;
    });
    const loader = createPluginModuleLoader({ reactModule: { createElement() {}, useState() {} } });
    const source = [
      'import { usePluginData } from "@sonparkserver/plugin-sdk/ui/bridge";',
      "export { usePluginAction } from '@paperclipai/plugin-sdk/ui';",
      'import "@paperclipai/plugin-sdk/ui/hooks";',
      'import React from "react";',
      "import { jsx } from 'react/jsx-runtime';",
      'import * as ReactDom from "react-dom";',
      "import { createRoot } from 'react-dom/client';",
    ].join("\n");

    const rewritten = loader.rewriteBareSpecifiers(source);
    expect(rewritten).not.toContain("@sonparkserver/plugin-sdk/ui/bridge");
    expect(rewritten).not.toContain("@paperclipai/plugin-sdk/ui");
    expect(rewritten).not.toContain('from "react"');
    expect(rewritten).not.toContain("from 'react/jsx-runtime'");
    expect(rewritten).not.toContain('from "react-dom"');
    expect(rewritten).not.toContain("from 'react-dom/client'");
    expect(rewritten).toContain("blob:module-loader-");
    expect(created).toHaveLength(5);

    const revoke = vi.spyOn(URL, "revokeObjectURL");
    loader.dispose();
    loader.dispose();
    expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual([...created].sort());
    expect(() => loader.rewriteBareSpecifiers(source)).toThrow("disposed");
  });

  it("preserves JSX runtime key semantics", () => {
    const props = { key: "old", children: "value" };
    expect(applyJsxRuntimeKey(props, undefined)).toBe(props);
    expect(applyJsxRuntimeKey(props, "new")).toEqual({ key: "new", children: "value" });
    expect(applyJsxRuntimeKey(null, 3)).toEqual({ key: 3 });
  });

  it("retains the explicit error when the realm has no React bridge runtime", async () => {
    const globalName = "__moduleLoaderMissingRuntimeTest__";
    const previous = Object.getOwnPropertyDescriptor(globalThis, globalName);
    Reflect.deleteProperty(globalThis, globalName);
    const source = createReactShimSource({ useState() {} }, globalName);
    const bytes = new TextEncoder().encode(source);
    const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join("");
    const moduleUrl = `data:text/javascript;base64,${btoa(binary)}`;
    try {
      await expect(import(/* @vite-ignore */ moduleUrl)).rejects.toThrow("SPS plugin React runtime is not initialized.");
    } finally {
      if (previous) Object.defineProperty(globalThis, globalName, previous);
      else Reflect.deleteProperty(globalThis, globalName);
    }
  });

  it("installs a Native import map for direct relative-module imports without changing rewrite behavior", async () => {
    const created: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:native-loader-${created.length}`;
      created.push(url);
      return url;
    });
    const revoked: string[] = [];
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(url => { revoked.push(url); });
    const loader = createPluginModuleLoader({
      reactModule: { createElement() {}, useState() {} },
      runtimeGlobalName: "__spsNativePluginBridge__",
      nativeImportMap: true,
      importMapNonce: "nonce-value-1234567890",
    });
    await expect(loader.importModule("/plugin/index.js")).rejects.toThrow("import map is not installed");
    loader.installImportMap();
    const map = document.querySelector('script[type="importmap"]');
    expect(map).not.toBeNull();
    expect((map as HTMLScriptElement).nonce).toBe("nonce-value-1234567890");
    const imports = JSON.parse(map!.textContent ?? "{}").imports;
    expect(imports.react).toMatch(/^blob:/);
    expect(imports["@sonparkserver/plugin-sdk/ui/bridge"]).toBe(imports["@paperclipai/plugin-sdk/ui"]);
    expect(loader.rewriteBareSpecifiers('import "./chunk.js";')).toBe('import "./chunk.js";');
    loader.dispose();
    expect(revoked).toEqual(created);
    map?.remove();
  });
});
