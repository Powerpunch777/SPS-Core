// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

const mockWorkspaceSurfacesApi = vi.hoisted(() => ({
  listInbox: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/SPS/dashboard" }),
  NavLink: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    className?: string | ((state: { isActive: boolean }) => string);
  }) => {
    const state = { isActive: false };
    return (
      <a
        href={to}
        className={typeof className === "function" ? className(state) : className}
      >
        {typeof children === "function" ? children(state) : children}
      </a>
    );
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 7 }),
}));

vi.mock("@/api/workspace-surfaces", () => ({
  workspaceSurfacesApi: mockWorkspaceSurfacesApi,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("MobileBottomNav", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockWorkspaceSurfacesApi.listInbox.mockResolvedValue({
      items: [
        { id: "one", unread: true },
        { id: "two", unread: false },
      ],
    });
  });

  afterEach(() => {
    container.remove();
    document.head.querySelector('meta[name="sps-basic-mode"]')?.remove();
    document.head.querySelector('meta[name="sps-core-baseline-mode"]')?.remove();
    document.head.querySelector('meta[name="sps-workplane-mode"]')?.remove();
    vi.clearAllMocks();
  });

  it("uses neutral Workspace navigation and the Core Inbox badge in baseline mode", async () => {
    for (const [name, content] of [
      ["sps-basic-mode", "true"],
      ["sps-core-baseline-mode", "true"],
    ]) {
      const meta = document.createElement("meta");
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MobileBottomNav visible />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Workspace");
    expect(container.textContent).toContain("Inbox");
    expect(container.textContent).toContain("Plugins");
    expect(container.textContent).toContain("1");
    expect(container.textContent).not.toContain("Tasks");
    expect(container.textContent).not.toContain("Create");

    flushSync(() => root.unmount());
  });
});
