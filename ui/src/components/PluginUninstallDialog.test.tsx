// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginUninstallDialog } from "./PluginUninstallDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginUninstallDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  async function render(onConfirm = vi.fn()) {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PluginUninstallDialog
          open
          pluginName="Team Workplane"
          onOpenChange={() => undefined}
          onConfirm={onConfirm}
        />,
      );
    });
    return { root, onConfirm };
  }

  it("keeps Inbox summaries by default", async () => {
    const { root, onConfirm } = await render();
    expect(document.body.textContent).toContain("Keep Inbox summaries");

    const confirm = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Uninstall and keep summaries");
    await act(async () => { confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(onConfirm).toHaveBeenCalledWith({ deleteInboxSummaries: false });
    await act(async () => { root.unmount(); });
  });

  it("requires an explicit choice before deleting Inbox summaries", async () => {
    const { root, onConfirm } = await render();
    const checkbox = document.body.querySelector('[aria-label="Delete Inbox summaries"]');
    await act(async () => { checkbox?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(document.body.textContent).toContain("Uninstall and delete summaries");
    const confirm = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Uninstall and delete summaries");
    await act(async () => { confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(onConfirm).toHaveBeenCalledWith({ deleteInboxSummaries: true });
    await act(async () => { root.unmount(); });
  });
});
