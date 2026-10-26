// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsEmptyWorkspace } from "./SpsEmptyWorkspace";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SpsEmptyWorkspace", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: ComponentProps<typeof SpsEmptyWorkspace>) {
    act(() => {
      root.render(
        <MemoryRouter>
          <SpsEmptyWorkspace {...props} />
        </MemoryRouter>,
      );
    });
  }

  it("renders the independent default empty state and plugin management link", () => {
    render({ workspaceName: "Prototype Workspace", pluginsHref: "/plugins" });

    expect(container.querySelector("main")?.getAttribute("data-sps-workspace-entry")).toBe("empty");
    expect(container.querySelector("h1")?.textContent).toBe("Prototype Workspace");
    expect(container.textContent).toContain("No default plugin selected.");
    expect(container.querySelector('a[href="/plugins"]')?.textContent).toBe("Manage plugins");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("nav, aside, [data-sps-surface-owner]")).toBeNull();
    expect(container.textContent).not.toMatch(/Agent|Dashboard|Shell/);
  });

  it("uses the generic unavailable message and invokes the supplied retry callback", () => {
    const onRetry = vi.fn();
    render({
      workspaceName: "Prototype Workspace",
      pluginsHref: "/plugins",
      status: "unavailable",
      onRetry,
    });

    expect(container.querySelector("main")?.getAttribute("data-sps-workspace-entry")).toBe("unavailable");
    expect(container.textContent).toContain("Workspace could not be loaded.");
    expect(container.textContent).not.toContain("offline");
    const retryButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Retry");
    act(() => retryButton?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows unavailable retry without a plugin link when no Workspace target exists", () => {
    const onRetry = vi.fn();
    render({
      workspaceName: "Workspace",
      pluginsHref: undefined,
      status: "unavailable",
      onRetry,
    });

    expect(container.textContent).toContain("Workspace could not be loaded.");
    expect(container.querySelector("a")).toBeNull();
    const retryButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Retry");
    expect(retryButton).not.toBeUndefined();
    act(() => retryButton?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows selected-plugin unavailability without exposing backend detail", () => {
    render({
      workspaceName: "Prototype Workspace",
      pluginsHref: "/plugins",
      selectionUnavailable: true,
    });

    expect(container.textContent).toContain("The selected plugin is unavailable.");
    expect(container.textContent).not.toContain("No default plugin selected.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("disables the retry button while a retry is pending", () => {
    render({
      workspaceName: "Prototype Workspace",
      pluginsHref: "/plugins",
      status: "unavailable",
      onRetry: vi.fn(),
      retrying: true,
    });

    const retryButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Retrying...");
    expect(retryButton?.disabled).toBe(true);
    expect(retryButton?.getAttribute("aria-busy")).toBe("true");
  });

  it("renders a long workspace name as escaped text with wrapping enabled", () => {
    const workspaceName = `${"a-very-long-workspace-name-".repeat(40)}<img src=x onerror=alert(1)>`;
    render({ workspaceName, pluginsHref: "/plugins" });

    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe(workspaceName);
    expect(heading?.className).toContain("w-full");
    expect(heading?.className).toContain("min-w-0");
    expect(heading?.className).toContain("break-words");
    expect(container.querySelector("img")).toBeNull();
  });
});
