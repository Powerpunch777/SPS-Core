// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "./Auth";

const getSessionMock = vi.hoisted(() => vi.fn());
const signInGoogleMock = vi.hoisted(() => vi.fn());

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
    signInGoogle: (input: unknown) => signInGoogleMock(input),
  },
}));

vi.mock("@/components/AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));
vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn(), toggleTheme: vi.fn() }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
    selectedCompanyId: null,
    companies: [],
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AuthPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getSessionMock.mockResolvedValue(null);
    signInGoogleMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function mount(initialEntry = "/auth") {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[initialEntry]}>
          <QueryClientProvider client={queryClient}>
            <Routes><Route path="/auth" element={<AuthPage />} /></Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    return root;
  }

  it("uses Google as the only interactive sign-in method", async () => {
    const root = await mount();
    expect(container.textContent).toContain("Continue with Google");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input[type="email"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("preserves a safe internal return path for Google sign-in", async () => {
    const root = await mount("/auth?next=%2Finvite%2Fpcp_invite_demo");
    const button = Array.from(container.querySelectorAll("button")).find((entry) =>
      entry.textContent?.includes("Continue with Google"),
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(signInGoogleMock).toHaveBeenCalledWith({ callbackURL: "/invite/pcp_invite_demo" });
    await act(async () => root.unmount());
  });
});
