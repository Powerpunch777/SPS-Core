// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsCoreTeamAccess } from "./SpsCoreTeamAccess";

const listInvitesMock = vi.hoisted(() => vi.fn());
const createCompanyInviteMock = vi.hoisted(() => vi.fn());
const revokeInviteMock = vi.hoisted(() => vi.fn());
const listTechnicalMembersMock = vi.hoisted(() => vi.fn());
const revokeTechnicalMemberMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const clipboardWriteTextMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    listInvites: (companyId: string, options?: unknown) => listInvitesMock(companyId, options),
    createCompanyInvite: (companyId: string, input: unknown) => createCompanyInviteMock(companyId, input),
    revokeInvite: (inviteId: string) => revokeInviteMock(inviteId),
  },
}));

vi.mock("@/api/spsNodes", () => ({
  spsNodesApi: {
    listTechnicalMembers: (companyId: string) => listTechnicalMembersMock(companyId),
    revokeTechnicalMember: (companyId: string, memberId: string) => revokeTechnicalMemberMock(companyId, memberId),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "workspace-1", selectedCompany: { id: "workspace-1", name: "SPS Test" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: pushToastMock }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SpsCoreTeamAccess", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listInvitesMock.mockResolvedValue({
      invites: [{
        id: "invite-active",
        state: "active",
        createdAt: "2026-07-29T00:00:00.000Z",
        expiresAt: "2026-07-29T01:00:00.000Z",
      }],
      nextOffset: null,
    });
    createCompanyInviteMock.mockResolvedValue({
      token: "sps_invite_ab12cd34ef56gh78",
      inviteUrl: "https://sps.example/invite/sps_invite_ab12cd34ef56gh78",
      expiresAt: "2026-07-29T01:00:00.000Z",
    });
    revokeInviteMock.mockResolvedValue(undefined);
    listTechnicalMembersMock.mockResolvedValue({
      members: [
        { id: "host-1", accountId: "host@example.com", isHost: true, status: "active", joinedAt: "2026-07-29T00:00:00.000Z", archivedAt: null, nodeCount: 1, activeNodeCount: 1 },
        { id: "member-1", accountId: "member@example.com", isHost: false, status: "active", joinedAt: "2026-07-29T00:00:00.000Z", archivedAt: null, nodeCount: 2, activeNodeCount: 1 },
      ],
    });
    revokeTechnicalMemberMock.mockResolvedValue({
      member: { id: "member-1", accountId: "member@example.com", status: "archived", joinedAt: "2026-07-29T00:00:00.000Z", archivedAt: "2026-07-29T01:00:00.000Z" },
      revokedNodeCount: 2,
    });
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates a technical Member invitation without exposing workflow roles", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><SpsCoreTeamAccess /></QueryClientProvider></MemoryRouter>);
    });
    await flushReact();

    expect(container.textContent).toContain("Team access");
    expect(container.textContent).toContain("technical access only");
    expect(container.textContent).not.toContain("Viewer");
    expect(container.textContent).not.toContain("Admin");
    expect(listInvitesMock).toHaveBeenCalledWith("workspace-1", { limit: 12, offset: 0 });
    expect(listTechnicalMembersMock).toHaveBeenCalledWith("workspace-1");
    expect(container.textContent).toContain("host@example.com (SPS Host)");
    expect(container.textContent).toContain("member@example.com");

    const createButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Create invitation"));
    await act(async () => { createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();

    expect(createCompanyInviteMock).toHaveBeenCalledWith("workspace-1", {
      allowedJoinTypes: "human",
      humanRole: "operator",
      agentMessage: null,
      expiresInMinutes: 60,
    });
    const desktopInput = container.querySelector('input[aria-label="Full SPS Desktop invitation"]') as HTMLInputElement | null;
    expect(desktopInput?.value).toContain("sps://join?");
    expect(desktopInput?.value).toContain("hub=https%3A%2F%2Fsps.example");

    const copyButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Copy full invitation"));
    await act(async () => { copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(desktopInput?.value);

    const revokeButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Revoke"));
    await act(async () => { revokeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    expect(revokeInviteMock).toHaveBeenCalledWith("invite-active");

    vi.stubGlobal("confirm", vi.fn(() => true));
    const removeButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Remove access"));
    await act(async () => { removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    expect(revokeTechnicalMemberMock).toHaveBeenCalledWith("workspace-1", "member-1");

    await act(async () => { root.unmount(); });
  });
});
