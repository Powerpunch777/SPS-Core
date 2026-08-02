// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyProjectSources } from "./CompanyProjectSources";

const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "company-1", name: "SPS Test" } }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("CompanyProjectSources", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    delete (window as Window & { spsDesktopWorkspace?: unknown }).spsDesktopWorkspace;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    delete (window as Window & { spsDesktopWorkspace?: unknown }).spsDesktopWorkspace;
    vi.clearAllMocks();
  });

  it("shows a Member-safe explanation without exposing Host paths or controls", async () => {
    const root = createRoot(container);
    root.render(<CompanyProjectSources />);
    await flushReact();

    expect(container.textContent).toContain("This computer cannot choose, replace, or store a Project source folder.");
    expect(container.textContent).toContain("The folder is never copied to this computer");
    expect(container.textContent).not.toContain("Choose Host folder");
    expect(container.textContent).not.toContain("C:\\Owner\\private-project");

    root.unmount();
  });

  it("lists and manages source folders only through the Owner Host bridge", async () => {
    const bridge = {
      listHostProjectSources: vi.fn().mockResolvedValue({
        privateTeamAccessEnabled: true,
        projects: [{ id: "project-1", name: "Host Project", sourcePath: "C:\\Owner\\private-project" }],
      }),
      chooseHostProjectSource: vi.fn(),
      clearHostProjectSource: vi.fn(),
      manageHostProjectSource: vi.fn(),
    };
    (window as Window & { spsDesktopWorkspace?: unknown }).spsDesktopWorkspace = bridge;

    const root = createRoot(container);
    root.render(<CompanyProjectSources />);
    await flushReact();

    expect(bridge.listHostProjectSources).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("C:\\Owner\\private-project");
    expect(container.textContent).toContain("Change Host folder");
    expect(container.textContent).toContain("Manage Member access");

    root.unmount();
  });
});
