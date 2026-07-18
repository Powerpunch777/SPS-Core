// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteLandingPage } from "./InviteLanding";

const getInviteMock = vi.hoisted(() => vi.fn());
const acceptInviteMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const healthGetMock = vi.hoisted(() => vi.fn());
const listCompaniesMock = vi.hoisted(() => vi.fn());
const setSelectedCompanyIdMock = vi.hoisted(() => vi.fn());

vi.mock("../api/access", () => ({
  accessApi: {
    getInvite: (token: string) => getInviteMock(token),
    acceptInvite: (token: string, input: unknown) => acceptInviteMock(token, input),
  },
}));
vi.mock("../api/auth", () => ({ authApi: { getSession: () => getSessionMock() } }));
vi.mock("../api/health", () => ({ healthApi: { get: () => healthGetMock() } }));
vi.mock("../api/companies", () => ({ companiesApi: { list: () => listCompaniesMock() } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
    selectedCompanyId: null,
    companies: [],
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: setSelectedCompanyIdMock,
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseInvite = {
  id: "invite-1",
  companyId: "company-1",
  companyName: "Acme Robotics",
  companyLogoUrl: "/api/invites/pcp_invite_test/logo",
  companyBrandColor: "#114488",
  inviteType: "company_join",
  allowedJoinTypes: "both",
  humanRole: "operator",
  expiresAt: "2027-03-07T00:10:00.000Z",
  inviteMessage: "Welcome aboard.",
};

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("InviteLandingPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({ fillStyle: "", fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn() })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      value: vi.fn(() => "data:image/png;base64,stub"),
    });
    getInviteMock.mockResolvedValue(baseInvite);
    acceptInviteMock.mockReset();
    healthGetMock.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    listCompaniesMock.mockResolvedValue([]);
    getSessionMock.mockResolvedValue(null);
    setSelectedCompanyIdMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderInvite() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/invite/pcp_invite_test"]}>
          <QueryClientProvider client={queryClient}>
            <Routes><Route path="/invite/:token" element={<InviteLandingPage />} /></Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await settle();
    await settle();
    return root;
  }

  it("sends an unauthenticated human invitee through the Google sign-in page", async () => {
    const root = await renderInvite();
    expect(container.textContent).toContain("Join Acme Robotics");
    expect(container.textContent).toContain("Continue with Google");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    const googleLink = Array.from(container.querySelectorAll("a")).find((entry) =>
      entry.textContent?.includes("Continue with Google"),
    );
    expect(googleLink?.getAttribute("href")).toBe("/auth?next=%2Finvite%2Fpcp_invite_test");
    expect(localStorage.getItem("paperclip:pending-invite-token")).toBe("pcp_invite_test");
    await act(async () => root.unmount());
  });

  it("automatically submits a signed-in human invitee for approval", async () => {
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", name: "Jane Example", email: "jane@example.com", image: null },
    });
    acceptInviteMock.mockResolvedValue({
      id: "join-1", companyId: "company-1", requestType: "human", status: "pending_approval",
    });
    const root = await renderInvite();
    await settle();
    expect(acceptInviteMock).toHaveBeenCalledWith("pcp_invite_test", { requestType: "human" });
    expect(container.textContent).toContain("Request to join Acme Robotics");
    await act(async () => root.unmount());
  });

  it("lets an existing signed-in member open the invited company", async () => {
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", name: "Jane Example", email: "jane@example.com", image: null },
    });
    listCompaniesMock.mockResolvedValue([{ id: "company-1", name: "Acme Robotics" }]);
    const root = await renderInvite();
    const openButton = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === "Open company");
    expect(openButton).toBeDefined();
    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(setSelectedCompanyIdMock).toHaveBeenCalledWith("company-1", { source: "manual" });
    await act(async () => root.unmount());
  });

  it("keeps agent invitations separate from human Google sign-in", async () => {
    getInviteMock.mockResolvedValue({ ...baseInvite, inviteType: "agent_join", allowedJoinTypes: "agent" });
    const root = await renderInvite();
    expect(container.textContent).toContain("Submit agent details");
    expect(container.textContent).not.toContain("Continue with Google");
    expect(container.querySelector("input")).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("shows a clear unavailable state for an invalid invite", async () => {
    getInviteMock.mockRejectedValue(new Error("not found"));
    const root = await renderInvite();
    expect(container.textContent).toContain("Invite not available");
    await act(async () => root.unmount());
  });
});
