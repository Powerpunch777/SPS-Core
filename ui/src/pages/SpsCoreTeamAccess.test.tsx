// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
const workspace = vi.hoisted(() => ({ id: "workspace-1" }));

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
  useCompany: () => ({ selectedCompanyId: workspace.id, selectedCompany: { id: workspace.id, name: "SPS Test" } }),
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

function invitation(token = "sps_invite_ab12cd34ef56gh78") {
  return { token, inviteUrl: `https://sps.example/invite/${token}`, expiresAt: "2026-07-29T01:00:00.000Z" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SpsCoreTeamAccess", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    workspace.id = "workspace-1";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clipboardWriteTextMock.mockReset().mockResolvedValue(undefined);
    listInvitesMock.mockResolvedValue({
      invites: [{
        id: "invite-active",
        state: "active",
        createdAt: "2026-07-29T00:00:00.000Z",
        expiresAt: "2026-07-29T01:00:00.000Z",
      }],
      nextOffset: null,
    });
    createCompanyInviteMock.mockResolvedValue(invitation());
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
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderWorkspace(companyId = "workspace-1") {
    workspace.id = companyId;
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><SpsCoreTeamAccess /></QueryClientProvider></MemoryRouter>);
    });
    await flushReact();
  }

  function button(label: string) {
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(label));
    expect(found).toBeDefined();
    return found!;
  }

  async function click(label: string) {
    await act(async () => { button(label).click(); });
    await flushReact();
  }

  it("keeps opaque account identifiers in details instead of using them as the person name", async () => {
    listTechnicalMembersMock.mockResolvedValueOnce({ members: [
      { id: "host", accountId: "sps_identity_opaquehost", isHost: true, status: "active", nodeCount: 0, activeNodeCount: 0 },
    ] });
    await renderWorkspace();
    await flushReact(); await flushReact();
    expect(container.querySelector("details")?.textContent).toContain("sps_identity_opaquehost");
    expect(container.querySelector("details")?.previousElementSibling?.textContent).toBe("SPS Host");
  });

  it("can retry failed invitation and member lists independently", async () => {
    listInvitesMock.mockRejectedValueOnce(new Error("offline"));
    listTechnicalMembersMock.mockRejectedValueOnce(new Error("offline"));
    await renderWorkspace();
    await flushReact(); await flushReact();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.find(button => button.textContent === "Retry members")).toBeTruthy();
    expect(buttons.find(button => button.textContent === "Retry invitations")).toBeTruthy();
    act(() => buttons.find(button => button.textContent === "Retry members")?.click());
    act(() => buttons.find(button => button.textContent === "Retry invitations")?.click());
    await flushReact(); await flushReact();
    expect(container.textContent).not.toContain("could not be loaded");
    expect(container.textContent).toContain("host@example.com");
  });

  it("creates a technical Member invitation without exposing workflow roles", async () => {
    await renderWorkspace();

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

  });

  it("clears a ready invitation and copied notice when the Workspace changes", async () => {
    await renderWorkspace();
    await click("Create invitation");
    await click("Copy full invitation");
    expect(button("Copied")).toBeDefined();

    await renderWorkspace("workspace-2");
    expect(container.querySelector('input[aria-label="Full SPS Desktop invitation"]')).toBeNull();
    expect(container.textContent).not.toContain("Desktop invitation ready");
    expect(container.textContent).not.toContain("Copied");
    expect(button("Create invitation").disabled).toBe(false);

    await renderWorkspace("workspace-1");
    expect(container.querySelector('input[aria-label="Full SPS Desktop invitation"]')).toBeNull();
    expect(clipboardWriteTextMock).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)("ignores a stale invitation %s without sharing loading, results, or notices", async (outcome) => {
    const pending = deferred<ReturnType<typeof invitation>>();
    createCompanyInviteMock.mockReturnValueOnce(pending.promise).mockResolvedValue(invitation("sps_invite_bc12cd34ef56gh78"));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await renderWorkspace();
    await click("Create invitation");
    expect(button("Creating...").disabled).toBe(true);

    await renderWorkspace("workspace-2");
    expect(button("Create invitation").disabled).toBe(false);
    expect(container.textContent).not.toContain("Creating...");
    await click("Create invitation");
    const currentLink = container.querySelector<HTMLInputElement>('input[aria-label="Full SPS Desktop invitation"]')?.value;
    expect(currentLink).toContain("SPS-BC12-CD34-EF56-GH78");
    pushToastMock.mockClear();
    invalidate.mockClear();

    await act(async () => {
      if (outcome === "resolve") pending.resolve(invitation());
      else pending.reject(new Error("Old Workspace creation failed"));
    });
    await flushReact();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Full SPS Desktop invitation"]')?.value).toBe(currentLink);
    expect(pushToastMock).not.toHaveBeenCalled();
    if (outcome === "resolve") {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sps-core", "team-invites", "workspace-1"] });
    }
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["sps-core", "team-invites", "workspace-2"] });
  });

  it("does not revive an old invitation after switching away and back to its Workspace", async () => {
    const pending = deferred<ReturnType<typeof invitation>>();
    createCompanyInviteMock.mockReturnValueOnce(pending.promise);
    await renderWorkspace();
    await click("Create invitation");
    await renderWorkspace("workspace-2");
    await renderWorkspace("workspace-1");
    pushToastMock.mockClear();

    await act(async () => { pending.resolve(invitation()); });
    await flushReact();
    expect(container.querySelector('input[aria-label="Full SPS Desktop invitation"]')).toBeNull();
    expect(button("Create invitation").disabled).toBe(false);
    expect(pushToastMock).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores a stale clipboard %s notice", async (outcome) => {
    const pending = deferred<void>();
    await renderWorkspace();
    await click("Create invitation");
    clipboardWriteTextMock.mockReturnValueOnce(pending.promise);
    await click("Copy full invitation");
    await renderWorkspace("workspace-2");
    pushToastMock.mockClear();

    await act(async () => {
      if (outcome === "resolve") pending.resolve();
      else pending.reject(new Error("Clipboard unavailable"));
    });
    await flushReact();
    expect(pushToastMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Copied");
  });

  it.each(["Revoke", "Remove access"])("keeps a late %s completion scoped to its original Workspace", async (label) => {
    const pending = deferred<unknown>();
    if (label === "Revoke") revokeInviteMock.mockReturnValueOnce(pending.promise);
    else revokeTechnicalMemberMock.mockReturnValueOnce(pending.promise);
    vi.stubGlobal("confirm", vi.fn(() => true));
    await renderWorkspace();
    await click(label);
    await renderWorkspace("workspace-2");
    pushToastMock.mockClear();

    await act(async () => { pending.resolve({ revokedNodeCount: 2 }); });
    await flushReact();
    expect(pushToastMock).not.toHaveBeenCalled();
    expect(button(label).disabled).toBe(false);
  });
});
