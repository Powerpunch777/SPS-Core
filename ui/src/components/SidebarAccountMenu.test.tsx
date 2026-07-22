// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarAccountMenu } from "./SidebarAccountMenu";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockToggleTheme = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    toggleTheme: mockToggleTheme,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SidebarAccountMenu", () => {
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
        image: "https://example.com/jane.png",
      },
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the signed-in user and opens the account card menu", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAccountMenu
            deploymentMode="authenticated"
            version="1.2.3"
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Jane Example");
    expect(container.textContent).not.toContain("jane@example.com");

    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Edit profile");
    expect(document.body.textContent).not.toContain("Instance settings");
    expect(document.body.textContent).toContain("SPS Guide");
    expect(document.body.textContent).toContain("Report an issue");

    // Feedback link opens in a new tab pointing at the feedback URL
    const feedbackAnchor = document.body.querySelector('a[href="https://github.com/Powerpunch777/SPS/issues"]') as HTMLAnchorElement | null;
    expect(feedbackAnchor).not.toBeNull();
    expect(feedbackAnchor?.getAttribute("target")).toBe("_blank");

    // Reporting appears after the guide and before the theme toggle.
    const menuText = document.body.querySelector('[data-slot="popover-content"]')?.textContent ?? "";
    const docsPos = menuText.indexOf("SPS Guide");
    const feedbackPos = menuText.indexOf("Report an issue");
    const themePos = menuText.indexOf("Switch to");
    expect(docsPos).toBeLessThan(feedbackPos);
    expect(feedbackPos).toBeLessThan(themePos);

    expect(document.body.textContent).toContain("SPS v1.2.3");
    expect(document.body.textContent).toContain("jane@example.com");
    expect(document.body.querySelector('[data-slot="popover-content"]')?.className)
      .toContain("w-(--sz-277px)");
    expect(document.body.querySelector('a[href="/company/settings/instance/profile"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the local SPS Desktop Google identity and signs out through its narrow bridge", async () => {
    const workspaceBridge = {
      getDesktopAccount: vi.fn().mockResolvedValue({
        signedIn: true,
        name: "SPS Owner",
        email: "owner@example.com",
        picture: null,
      }),
      signOutDesktopAccount: vi.fn().mockResolvedValue(undefined),
    };
    Object.assign(window, { spsDesktopWorkspace: workspaceBridge });
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAccountMenu deploymentMode="local_trusted" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("SPS Owner");
    const trigger = container.querySelector('button[aria-label="Open account menu"]');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(document.body.textContent).toContain("owner@example.com");
    expect(document.body.textContent).toContain("SPS Desktop 로그아웃");

    const signOut = [...document.body.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("SPS Desktop 로그아웃"));
    await act(async () => {
      signOut?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(workspaceBridge.signOutDesktopAccount).toHaveBeenCalledOnce();

    delete (window as Window & { spsDesktopWorkspace?: unknown }).spsDesktopWorkspace;
    await act(async () => root.unmount());
  });
});
