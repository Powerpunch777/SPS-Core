// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { AgentWorkingDirectoryField } from "./AgentWorkingDirectoryField";

vi.mock("./agent-config-primitives", () => ({ DraftInput: ({ value, onCommit, immediate: _immediate, ...props }: any) => <input {...props} value={value} onChange={event => onCommit(event.target.value)} /> }));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => <button>Path instructions</button> }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentWorkingDirectoryField", () => {
  let container: HTMLDivElement;
  let root: Root;
  let commit: Mock<(value: string) => void>;
  beforeEach(() => {
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); commit = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); delete (window as any).spsDesktopWorkspace;
  });
  function render(value = "C:\\old") {
    act(() => root.render(<AgentWorkingDirectoryField value={value} onCommit={commit} />));
  }
  async function click() { await act(async () => { container.querySelector<HTMLButtonElement>("button")?.click(); }); }

  it("keeps manual entry available without a Host bridge", () => {
    render();
    expect(container.querySelector('input[aria-label="Default working folder"]')).not.toBeNull();
    expect(container.textContent).toContain("Path instructions");
    expect(commit).not.toHaveBeenCalled();
  });

  it("uses only the native selection and never persists automatically", async () => {
    const choose = vi.fn().mockResolvedValue({ cwd: "C:\\chosen" });
    (window as any).spsDesktopWorkspace = { chooseAgentWorkingDirectory: choose };
    render(); await click();
    expect(choose).toHaveBeenCalledOnce(); expect(choose).toHaveBeenCalledWith();
    expect(commit).toHaveBeenCalledWith("C:\\chosen");
  });

  it("preserves the value when the chooser is cancelled", async () => {
    (window as any).spsDesktopWorkspace = { chooseAgentWorkingDirectory: vi.fn().mockResolvedValue(null) };
    render(); await click(); expect(commit).not.toHaveBeenCalled();
  });

  it("does not expose native error details or accept malformed responses", async () => {
    for (const value of [Promise.reject(new Error("private-path-or-token")), Promise.resolve({ cwd: "bad\0path" }), Promise.resolve({})]) {
      (window as any).spsDesktopWorkspace = { chooseAgentWorkingDirectory: () => value };
      render(); await click();
      expect(container.textContent).toContain("Could not select a folder");
      expect(container.textContent).not.toContain("private-path-or-token");
      expect(commit).not.toHaveBeenCalled();
    }
  });

  it("does not overwrite edits while the native chooser was open and ignores a double click", async () => {
    let resolve: (value: { cwd: string }) => void = () => {};
    const choose = vi.fn(() => new Promise<{ cwd: string }>(done => { resolve = done; }));
    (window as any).spsDesktopWorkspace = { chooseAgentWorkingDirectory: choose };
    render();
    act(() => { const button = container.querySelector<HTMLButtonElement>("button")!; button.click(); button.click(); });
    expect(choose).toHaveBeenCalledOnce();
    render("C:\\edited");
    await act(async () => { resolve({ cwd: "C:\\chosen" }); });
    expect(commit).not.toHaveBeenCalled(); expect(container.textContent).toContain("folder field changed");
  });

  it("ignores a selection after navigating away from the form", async () => {
    let resolve: (value: { cwd: string }) => void = () => {};
    (window as any).spsDesktopWorkspace = { chooseAgentWorkingDirectory: () => new Promise<{ cwd: string }>(done => { resolve = done; }) };
    render(); act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    act(() => root.render(<div>Another Agent</div>));
    await act(async () => { resolve({ cwd: "C:\\chosen" }); });
    expect(commit).not.toHaveBeenCalled();
  });
});
