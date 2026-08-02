// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
}));
const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenOnboarding = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockCreateCompany = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockLocation = vi.hoisted(() => ({ pathname: "/PAP/dashboard" }));
const mockSidebarPreferencesApi = vi.hoisted(() => ({
  getCompanyOrder: vi.fn(),
  updateCompanyOrder: vi.fn(),
}));

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/api/sidebarPreferences", () => ({
  sidebarPreferencesApi: mockSidebarPreferencesApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      {
        id: "company-1",
        issuePrefix: "PAP",
        name: "Acme Labs",
        brandColor: "#3366ff",
        status: "active",
      },
      {
        id: "company-2",
        issuePrefix: "STR",
        name: "Strata",
        brandColor: "#36a269",
        status: "active",
      },
      {
        id: "company-3",
        issuePrefix: "ANA",
        name: "Anachronist Wiki",
        brandColor: "#a36a21",
        status: "active",
      },
    ],
    selectedCompany: {
      id: "company-1",
      issuePrefix: "PAP",
      name: "Acme Labs",
      brandColor: "#3366ff",
      status: "active",
    },
    setSelectedCompanyId: mockSetSelectedCompanyId,
    createCompany: mockCreateCompany,
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({
    openOnboarding: mockOpenOnboarding,
  }),
}));

vi.mock("./CompanyPatternIcon", () => ({
  CompanyPatternIcon: ({ companyName }: { companyName: string }) => (
    <span aria-hidden="true">{companyName.slice(0, 1)}</span>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("SidebarCompanyMenu", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
      },
    });
    mockAuthApi.signOut.mockResolvedValue(undefined);
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: null,
      userId: "user-1",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      source: "local_implicit",
      keyId: null,
    });
    mockCreateCompany.mockResolvedValue({
      id: "company-4",
      issuePrefix: "NEW",
      name: "New Workspace",
      status: "active",
    });
    mockSidebarPreferencesApi.getCompanyOrder.mockResolvedValue({
      orderedIds: ["company-1", "company-2", "company-3"],
      updatedAt: null,
    });
    mockSidebarPreferencesApi.updateCompanyOrder.mockResolvedValue({
      orderedIds: ["company-1", "company-2", "company-3"],
      updatedAt: null,
    });
    mockLocation.pathname = "/PAP/dashboard";
  });

  afterEach(async () => {
    await flushReact();
    container.remove();
    await flushReact();
    document.body.replaceChildren();
    document.head.querySelector('meta[name="sps-core-baseline-mode"]')?.remove();
    vi.clearAllMocks();
  });

  it("uses the neutral workspace switcher and creates a workspace in SPS Core mode", async () => {
    const meta = document.createElement("meta");
    meta.name = "sps-core-baseline-mode";
    meta.content = "true";
    document.head.appendChild(meta);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs workspace switcher"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Switch workspace");
    expect(document.body.textContent).toContain("Create new workspace...");
    expect(document.body.textContent).toContain("Team access");
    expect(document.body.textContent).toContain("Host settings");
    expect(document.body.textContent).not.toContain("Company settings");
    expect(document.body.textContent).not.toContain("PAP");

    const createItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Create new workspace"));
    expect(createItem).toBeTruthy();
    act(() => {
      createItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const nameInput = document.body.querySelector<HTMLInputElement>("#new-workspace-name");
    expect(nameInput).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(nameInput, "Product Lab");
      nameInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const form = nameInput?.closest("form");
    act(() => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockCreateCompany).toHaveBeenCalledWith({ name: "Product Lab" });
    expect(mockOpenOnboarding).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/dashboard");

    act(() => {
      root.unmount();
    });
  });

  it("keeps Host-only management actions out of a Member workspace switcher", async () => {
    const meta = document.createElement("meta");
    meta.name = "sps-core-baseline-mode";
    meta.content = "true";
    document.head.appendChild(meta);
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: null,
      userId: "member-1",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs workspace switcher"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).not.toContain("Create new workspace...");
    expect(document.body.textContent).not.toContain("Team access");
    const menuItems = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'));
    expect(menuItems.some((item) => item.textContent?.trim() === "Host settings")).toBe(false);
    expect(document.body.textContent).toContain("Host settings are managed on the Host computer.");

    act(() => {
      root.unmount();
    });
  });

  it("uses company-centric create copy without the chat flag", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs company switcher"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Create new company...");
    expect(document.body.textContent).not.toContain("Add company...");

    act(() => {
      root.unmount();
    });
  });

  it("shows the requested company actions and signs out through the dropdown", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Acme Labs");

    const trigger = container.querySelector('button[aria-label="Open Acme Labs company switcher"]');
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Switch company");
    expect(document.body.textContent).toContain("Edit");
    expect(document.body.textContent).toContain("Strata");
    expect(document.body.textContent).toContain("ANA");
    expect(document.body.textContent).toContain("Create new company...");
    expect(document.body.textContent).toContain("Invite people to Acme Labs");
    expect(document.body.textContent).toContain("Company settings");
    expect(document.body.textContent).toContain("Sign out");

    const signOutButton = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Sign out"));
    expect(signOutButton).toBeTruthy();

    act(() => {
      signOutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAuthApi.signOut).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("toggles company order editing without selecting a company", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs company switcher"]');
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const editButton = Array.from(document.body.querySelectorAll("button"))
      .find((element) => element.textContent === "Edit");
    expect(editButton).toBeTruthy();

    act(() => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Done");
    expect(document.body.textContent).not.toContain("PAP");
    expect(document.body.textContent).not.toContain("ANA");
    expect(document.body.querySelector('button[aria-label="Reorder Strata"]')).toBeTruthy();

    const strataItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Strata"));
    expect(strataItem).toBeTruthy();

    act(() => {
      strataItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockSetSelectedCompanyId).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("navigates to the selected company dashboard from company-prefixed routes", async () => {
    mockLocation.pathname = "/PAP/issues";
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs company switcher"]');
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const strataItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Strata"));
    expect(strataItem).toBeTruthy();

    act(() => {
      strataItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockSetSelectedCompanyId).toHaveBeenCalledWith("company-2");
    expect(mockNavigate).toHaveBeenCalledWith("/STR/dashboard");

    act(() => {
      root.unmount();
    });
  });
});
