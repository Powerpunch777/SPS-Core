// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentBoardAccess } from "@/api/access";
import type { SpsModelConnection, SpsModelGrant } from "@/api/sps-model-connections";
import type { CompanyPluginRecord } from "@/api/plugins";
import type { CompanySecret } from "@paperclipai/shared";

const mocks = vi.hoisted(() => ({
  workspaceId: "workspace-1",
  getAccess: vi.fn(),
  listConnections: vi.fn(),
  createConnection: vi.fn(),
  setStatus: vi.fn(),
  listGrants: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  listSecrets: vi.fn(),
  listPlugins: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.getAccess } }));
vi.mock("@/api/secrets", () => ({ secretsApi: { list: mocks.listSecrets } }));
vi.mock("@/api/plugins", () => ({ pluginsApi: { listForCompany: mocks.listPlugins } }));
vi.mock("@/api/sps-model-connections", () => ({
  spsModelConnectionsApi: {
    list: mocks.listConnections,
    create: mocks.createConnection,
    setStatus: mocks.setStatus,
    listGrants: mocks.listGrants,
    grant: mocks.grant,
    revoke: mocks.revoke,
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: mocks.workspaceId, selectedCompany: { id: mocks.workspaceId, name: `Workspace ${mocks.workspaceId}` } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));
vi.mock("@/lib/sps-core-baseline-mode", () => ({ isSpsCoreBaselineModeEnabled: () => true }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/components/ui/alert-dialog", () => {
  let changeOpen: (open: boolean) => void = () => undefined;
  return {
    AlertDialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) => {
      changeOpen = onOpenChange;
      return open ? <div role="dialog">{children}</div> : null;
    },
    AlertDialogAction: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
    AlertDialogCancel: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} onClick={event => { onClick?.(event); changeOpen(false); }}>{children}</button>,
    AlertDialogContent: ({ children }: React.PropsWithChildren) => <section>{children}</section>,
    AlertDialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
    AlertDialogFooter: ({ children }: React.PropsWithChildren) => <footer>{children}</footer>,
    AlertDialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
    AlertDialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  };
});

import { ApiError } from "@/api/client";
import { SpsModelConnections } from "./SpsModelConnections";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const SECRET_ID = "22222222-2222-4222-8222-222222222222";
const PLUGIN_ID = "33333333-3333-4333-8333-333333333333";
const GRANT_ID = "44444444-4444-4444-8444-444444444444";

function access(overrides: Partial<CurrentBoardAccess> = {}): CurrentBoardAccess {
  return { user: null, userId: "host-user", isInstanceAdmin: false, isCoreHost: true, companyIds: [], source: "session", keyId: null, ...overrides };
}

function connection(id = CONNECTION_ID, companyId = "workspace-1"): SpsModelConnection {
  return {
    id, companyId, displayName: "Primary model", protocol: "responses_text_v1", endpoint: "https://provider.example/v1/responses",
    model: "example-model", secretId: SECRET_ID, versionSelector: "latest", status: "active", allowLoopbackHttp: false,
    timeoutMs: 30_000, maxOutputTokens: 1_024, maxRequestBytes: 65_536, maxResponseBytes: 1_048_576,
    maxConcurrentRequests: 1, createdByUserId: "host-user", createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z",
  };
}

function secret(companyId = "workspace-1"): CompanySecret {
  return {
    id: SECRET_ID, companyId, scope: "company", ownerUserId: null, userSecretDefinitionId: null, key: "provider_key",
    name: "Provider credential", provider: "local_encrypted", status: "active", managedMode: "paperclip_managed", externalRef: null,
    providerConfigId: null, providerMetadata: null, latestVersion: 1, description: null, lastResolvedAt: null, lastRotatedAt: null,
    deletedAt: null, createdByAgentId: null, createdByUserId: "host-user", referenceCount: 0,
    createdAt: new Date("2026-10-27T00:00:00.000Z"), updatedAt: new Date("2026-10-27T00:00:00.000Z"),
  };
}

function plugin(companyId = "workspace-1"): CompanyPluginRecord {
  return {
    id: PLUGIN_ID, pluginKey: "sample.plugin", displayName: "Sample Plugin", version: "1.0.0", status: "ready",
    capabilities: ["sps.models.submit"],
    activation: { pluginId: PLUGIN_ID, pluginKey: "sample.plugin", companyId, enabled: true, source: "explicit", defaultEnabled: false },
  };
}

function grant(companyId = "workspace-1"): SpsModelGrant {
  return { id: GRANT_ID, companyId, pluginId: PLUGIN_ID, connectionId: CONNECTION_ID, bindingId: "55555555-5555-4555-8555-555555555555", revision: 1, status: "active", revokedAt: null, createdByUserId: "host-user", createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => root.render(<SpsModelConnections />));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
}

function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function click(button: HTMLButtonElement | null) {
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function fillConnectionForm() {
  const form = container.querySelectorAll("form")[0]!;
  const inputs = form.querySelectorAll("input");
  act(() => {
    changeValue(inputs[0]!, "Primary model");
    changeValue(inputs[1]!, "https://provider.example/v1/responses");
    changeValue(inputs[2]!, "example-model");
    changeValue(form.querySelector("select")!, SECRET_ID);
  });
  return form;
}

describe("SpsModelConnections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceId = "workspace-1";
    mocks.getAccess.mockResolvedValue(access());
    mocks.listConnections.mockResolvedValue([]);
    mocks.createConnection.mockResolvedValue(connection());
    mocks.setStatus.mockResolvedValue(connection());
    mocks.listGrants.mockResolvedValue([]);
    mocks.grant.mockResolvedValue(grant());
    mocks.revoke.mockResolvedValue(undefined);
    mocks.listSecrets.mockResolvedValue([secret()]);
    mocks.listPlugins.mockResolvedValue({ companyId: "workspace-1", plugins: [plugin()] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not read credential or Plugin metadata when the Host model route denies access", async () => {
    mocks.listConnections.mockRejectedValue(new ApiError("raw backend detail", 403, { error: "raw backend detail" }));
    render();
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Only the local Host");
    expect(mocks.listSecrets).not.toHaveBeenCalled();
    expect(mocks.listPlugins).not.toHaveBeenCalled();
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("raw backend detail");
  });

  it("creates a connection from selected credential metadata and explicitly grants a ready Plugin", async () => {
    mocks.listConnections.mockResolvedValueOnce([]).mockResolvedValue([connection()]);
    render();
    await settle();

    const createForm = fillConnectionForm();
    act(() => {
      createForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(mocks.createConnection).toHaveBeenCalledWith("workspace-1", {
      displayName: "Primary model", secretId: SECRET_ID,
      transport: { endpoint: "https://provider.example/v1/responses", model: "example-model", allowLoopbackHttp: false, timeoutMs: 30_000, maxOutputTokens: 1_024 },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(container.textContent).toContain("Provider readiness unknown");
    expect(container.textContent).toContain("The provider has not been contacted");

    const grantForm = container.querySelectorAll("form")[1]!;
    act(() => {
      changeValue(grantForm.querySelector("select")!, PLUGIN_ID);
    });
    act(() => {
      grantForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(mocks.grant).toHaveBeenCalledWith("workspace-1", CONNECTION_ID, PLUGIN_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("requires confirmation before revoking a Plugin grant and leaves it intact on cancel", async () => {
    mocks.listConnections.mockResolvedValue([connection()]);
    mocks.listGrants.mockResolvedValue([grant()]);
    render();
    await settle();

    click([...container.querySelectorAll("button")].find(button => button.textContent?.includes("Revoke access")) ?? null);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Revoke Plugin access?");
    click([...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === "Cancel") ?? null);
    expect(mocks.revoke).not.toHaveBeenCalled();

    click([...container.querySelectorAll("button")].find(button => button.textContent?.includes("Revoke access")) ?? null);
    click([...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent?.includes("Revoke access")) ?? null);
    await settle();
    expect(mocks.revoke).toHaveBeenCalledWith("workspace-1", GRANT_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("requires a fresh read after an uncertain write and never repeats it automatically", async () => {
    mocks.listConnections.mockResolvedValueOnce([]).mockResolvedValue([connection()]);
    mocks.createConnection.mockRejectedValueOnce(new Error("private response details"));
    render();
    await settle();
    const form = fillConnectionForm();
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(mocks.createConnection).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed");
    expect(container.textContent).not.toContain("private response details");
    expect(container.querySelector("form")).toBeNull();
    click([...container.querySelectorAll("button")].find(button => button.textContent?.includes("Refresh settings")) ?? null);
    await settle();
    expect(container.textContent).toContain("Primary model");
    expect(mocks.createConnection).toHaveBeenCalledTimes(1);
  });

  it("offers only enabled Plugins that declare model submission support", async () => {
    mocks.listConnections.mockResolvedValue([connection()]);
    mocks.listPlugins.mockResolvedValue({ companyId: "workspace-1", plugins: [plugin(),
      { ...plugin(), id: "77777777-7777-4777-8777-777777777777", displayName: "No model support", capabilities: [] },
      { ...plugin(), id: "88888888-8888-4888-8888-888888888888", displayName: "Legacy unknown support", capabilities: undefined }] });
    render();
    await settle();
    const options = [...container.querySelectorAll("option")].map(option => option.textContent);
    expect(options).toContain("Sample Plugin");
    expect(options).not.toContain("No model support");
    expect(options).not.toContain("Legacy unknown support");
  });

  it("ignores a late connection response after switching Workspaces", async () => {
    let resolveOld!: (rows: SpsModelConnection[]) => void;
    mocks.listConnections.mockImplementation((companyId: string) => companyId === "workspace-1"
      ? new Promise(resolve => { resolveOld = resolve; })
      : Promise.resolve([{ ...connection("66666666-6666-4666-8666-666666666666", "workspace-2"), displayName: "New Workspace model" }]));
    render();
    await settle();
    expect(resolveOld).toBeTypeOf("function");

    mocks.workspaceId = "workspace-2";
    render();
    await settle();
    expect(container.textContent).toContain("New Workspace model");

    await act(async () => {
      resolveOld([connection()]);
      await Promise.resolve();
    });
    await settle();
    expect(container.textContent).not.toContain("Primary model");
    expect(mocks.listSecrets).toHaveBeenCalledTimes(1);
    expect(mocks.listSecrets).toHaveBeenCalledWith("workspace-2");
    expect(mocks.listPlugins).toHaveBeenCalledWith("workspace-2");
  });
});
