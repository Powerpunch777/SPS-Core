import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { agents, createDb } from "../../packages/db/src/index.ts";
import { resolveSpsNodeExecutionTarget } from "../../server/src/services/sps-node-execution";

const BASE = process.env.PAPERCLIP_E2E_BASE_URL ?? "http://127.0.0.1:3105";
const DATA_DIR = process.env.PAPERCLIP_E2E_DATA_DIR ?? process.env.PAPERCLIP_HOME;
const CONFIG_PATH = process.env.PAPERCLIP_E2E_CONFIG_PATH ?? path.resolve(process.cwd(), ".paperclip/config.json");
const BOOTSTRAP_SCRIPT_PATH = path.resolve(process.cwd(), "packages/db/scripts/create-auth-bootstrap-invite.ts");
const TSX_CLI_PATH = path.resolve(process.cwd(), "cli/node_modules/tsx/dist/cli.mjs");
const OWNER_PASSWORD = "paperclip-owner-password";
const INVITED_PASSWORD = "paperclip-invited-password";
const NODE_E2E_TIMEOUT_MS = 45_000;
const SPS_DESKTOP_NODE_MODULE_PATH = process.env.SPS_DESKTOP_NODE_MODULE?.trim();

type HumanUser = {
  name: string;
  email: string;
  password: string;
};

type CompanySummary = {
  id: string;
  name: string;
  issuePrefix?: string | null;
};

type CompanyMember = {
  id: string;
  membershipRole: "owner" | "admin" | "operator" | "viewer";
  status: "pending" | "active" | "suspended";
  user: { id: string; email: string | null; name: string | null } | null;
};

type SessionJsonResponse<T> = {
  ok: boolean;
  status: number;
  text: string;
  json: T | null;
};

type NodeIdentity = {
  publicKeyPem: string;
  privateKeyPem: string;
};

type DesktopNodeClient = {
  createNodeIdentity: () => NodeIdentity;
  startSpsDesktopAuth: (input: Record<string, unknown>) => Promise<{ id: string; token: string; boardApiToken: string }>;
  registerSpsNode: (input: Record<string, unknown>) => Promise<{ id: string }>;
  sendSpsNodeHeartbeat: (input: Record<string, unknown>) => Promise<unknown>;
  claimSpsNodeCommand: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  executeSpsNodeCommand: (input: Record<string, unknown>) => Promise<{ exitCode: number | null }>;
};

const runId = Date.now();
const companyName = `MU-Auth-${runId}`;
const ownerUser: HumanUser = {
  name: "Owner User",
  email: `owner-${runId}@paperclip.local`,
  password: OWNER_PASSWORD,
};
const invitedUser: HumanUser = {
  name: "Invited User",
  email: `invitee-${runId}@paperclip.local`,
  password: INVITED_PASSWORD,
};

function createBootstrapInvite() {
  if (!DATA_DIR) {
    throw new Error("PAPERCLIP_E2E_DATA_DIR or PAPERCLIP_HOME is required for authenticated bootstrap tests");
  }
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Authenticated bootstrap config not found at ${CONFIG_PATH}`);
  }
  if (!existsSync(BOOTSTRAP_SCRIPT_PATH)) {
    throw new Error(`Authenticated bootstrap helper not found at ${BOOTSTRAP_SCRIPT_PATH}`);
  }
  if (!existsSync(TSX_CLI_PATH)) {
    throw new Error(`Workspace tsx runtime not found at ${TSX_CLI_PATH}`);
  }

  return execFileSync(
    process.execPath,
    [
      TSX_CLI_PATH,
      BOOTSTRAP_SCRIPT_PATH,
      "--config",
      CONFIG_PATH,
      "--base-url",
      BASE,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        PAPERCLIP_HOME: DATA_DIR,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  ).trim();
}

async function createLocalTestAccount(page: Page, user: HumanUser) {
  // Production SPS uses Google-only sign-in. The isolated authorization E2E
  // enables Better Auth's local test endpoint so it can create distinct human
  // sessions without driving a real Google account through the browser.
  const signUpResult = await page.evaluate(async (credentials) => {
    const response = await fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    return { ok: response.ok, status: response.status };
  }, user);
  expect(signUpResult.ok, `test account sign-up returned ${signUpResult.status}`).toBe(true);
}

async function signUp(page: Page, user: HumanUser) {
  await page.goto(`${BASE}/auth`);
  await expect(page.getByRole("heading", { name: "Continue to SPS" })).toBeVisible();
  await createLocalTestAccount(page, user);

  await page.goto(`${BASE}/`);
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function acceptBootstrapInvite(page: Page, inviteUrl: string) {
  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: "Set up SPS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Accept bootstrap invite" })).toBeVisible();
  await page.getByRole("button", { name: "Accept invite" }).click();
  await expect(page.getByRole("heading", { name: "Bootstrap complete" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("link", { name: "Open board" }).click();
}

async function createCompanyForSession(page: Page, nextCompanyName: string) {
  const createRes = await sessionJsonRequest<CompanySummary>(page, `${BASE}/api/companies`, {
    method: "POST",
    data: { name: nextCompanyName },
  });
  expect(createRes.ok).toBe(true);
  expect(createRes.json).toBeTruthy();
  return createRes.json!;
}

async function createAuthenticatedInvite(page: Page, companyPrefix: string) {
  await page.goto(`${BASE}/${companyPrefix}/company/settings/invites`);
  await expect(page.getByRole("heading", { name: "SPS invites" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("radio", { name: /Operator/ }).check();
  await page.getByRole("button", { name: "Create SPS invite" }).click();
  const inviteField = page.getByRole("textbox", { name: "Latest invite URL" });
  await expect(inviteField).toBeVisible({ timeout: 20_000 });
  return (await inviteField.inputValue()).trim();
}

async function signUpFromInvite(page: Page, inviteUrl: string, user: HumanUser) {
  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: "Continue with Google" })).toBeVisible();
  await createLocalTestAccount(page, user);
  await page.reload();
  // A signed-in human invite is completed automatically after the identity
  // returns from Google, then SPS navigates to the selected company.
  await expect(page.getByRole("button", { name: "Open account menu" })).toContainText(user.name, {
    timeout: 20_000,
  });
}

async function sessionJsonRequest<T>(
  page: Page,
  url: string,
  options: {
    method?: string;
    data?: unknown;
  } = {}
) {
  return page.evaluate(
    async ({ url: targetUrl, method, data }) => {
      const response = await fetch(targetUrl, {
        method,
        credentials: "include",
        headers: data === undefined ? undefined : { "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const text = await response.text();
      let json: unknown = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        text,
        json,
      };
    },
    {
      url,
      method: options.method ?? "GET",
      data: options.data,
    }
  ) as Promise<SessionJsonResponse<T>>;
}

async function waitForMember(page: Page, companyId: string, email: string) {
  let member: CompanyMember | null = null;
  await expect
    .poll(
      async () => {
        const membersRes = await sessionJsonRequest<{ members: CompanyMember[] }>(
          page,
          `${BASE}/api/companies/${companyId}/members`
        );
        expect(membersRes.ok).toBe(true);
        const body = membersRes.json;
        if (!body) return null;
        member = body.members.find((entry) => entry.user?.email === email) ?? null;
        return member;
      },
      {
        timeout: 20_000,
        intervals: [500, 1_000, 2_000],
      }
    )
    .toMatchObject({
      status: "active",
      membershipRole: "operator",
      user: { email },
    });
  return member!;
}

async function waitForMemberRole(
  page: Page,
  companyId: string,
  memberId: string,
  membershipRole: CompanyMember["membershipRole"]
) {
  await expect
    .poll(
      async () => {
        const membersRes = await sessionJsonRequest<{ members: CompanyMember[] }>(
          page,
          `${BASE}/api/companies/${companyId}/members`
        );
        expect(membersRes.ok).toBe(true);
        const body = membersRes.json;
        if (!body) return null;
        return body.members.find((member) => member.id === memberId) ?? null;
      },
      {
        timeout: 20_000,
        intervals: [500, 1_000, 2_000],
      }
    )
    .toMatchObject({
      id: memberId,
      membershipRole,
    });
}

async function setMemberRole(
  page: Page,
  companyPrefix: string,
  email: string,
  membershipRole: CompanyMember["membershipRole"]
) {
  await page.goto(`${BASE}/${companyPrefix}/company/settings/members`);
  await expect(page.getByRole("heading", { name: "Company Members" })).toBeVisible({ timeout: 20_000 });
  const memberRow = page.getByText(email, { exact: true }).locator("xpath=../..");
  await expect(memberRow.getByRole("button", { name: "Edit" })).toBeVisible({ timeout: 20_000 });
  await memberRow.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Edit member" })).toBeVisible();
  await dialog.getByLabel("Company role").selectOption(membershipRole ?? "");
  await dialog.getByRole("button", { name: "Save member" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
}

async function newPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

async function loadDesktopNodeClient(): Promise<DesktopNodeClient> {
  if (!SPS_DESKTOP_NODE_MODULE_PATH) {
    throw new Error("SPS_DESKTOP_NODE_MODULE is required for the SPS Desktop Node integration test");
  }
  return await import(pathToFileURL(SPS_DESKTOP_NODE_MODULE_PATH).href) as DesktopNodeClient;
}

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function authorizeDesktopNode(client: DesktopNodeClient, page: Page, companyId: string) {
  const challenge = await client.startSpsDesktopAuth({
    hubUrl: BASE,
    companyId,
    clientName: "SPS Node E2E",
  });
  const approval = await sessionJsonRequest(page, `${BASE}/api/cli-auth/challenges/${challenge.id}/approve`, {
    method: "POST",
    data: { token: challenge.token },
  });
  expect(approval.ok, `desktop authorization returned ${approval.status}`).toBe(true);
  return challenge.boardApiToken as string;
}

async function waitForOneSpsNodeCommand(input: {
  hubUrl: string;
  nodeId: string;
  identity: NodeIdentity;
  accessToken: string;
  workspace: string;
  client: DesktopNodeClient;
}) {
  const deadline = Date.now() + NODE_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const command = await input.client.claimSpsNodeCommand({
      hubUrl: input.hubUrl,
      nodeId: input.nodeId,
      identity: input.identity,
      accessToken: input.accessToken,
    });
    if (command) {
      return input.client.executeSpsNodeCommand({
        command,
        hubUrl: input.hubUrl,
        nodeId: input.nodeId,
        identity: input.identity,
        accessToken: input.accessToken,
        profile: {
          defaultWorkspacePath: input.workspace,
          projectWorkspaces: {},
        },
      });
    }
    await pause(75);
  }
  throw new Error("SPS Desktop Node did not receive a queued command before the E2E deadline.");
}

test.describe("Multi-user: authenticated mode", () => {
  test("authenticated humans can bootstrap, invite, join, and respect viewer restrictions", async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000);

    const healthRes = await page.request.get(`${BASE}/api/health`);
    expect(healthRes.ok()).toBe(true);
    const health = (await healthRes.json()) as {
      deploymentMode?: string;
      bootstrapStatus?: string;
    };
    expect(health.deploymentMode).toBe("authenticated");

    await signUp(page, ownerUser);
    await acceptBootstrapInvite(page, createBootstrapInvite());

    const company = await createCompanyForSession(page, companyName);
    const companyPrefix = company.issuePrefix ?? company.id;
    await page.goto(`${BASE}/${companyPrefix}/dashboard`);
    const accountMenuTrigger = page.getByRole("button", { name: "Open account menu" });
    await expect(accountMenuTrigger).toContainText(ownerUser.name);
    await accountMenuTrigger.click();
    await expect(page.getByText(ownerUser.email)).toBeVisible();
    const inviteUrl = await createAuthenticatedInvite(page, companyPrefix);

    const invited = await newPage(browser);
    try {
      await signUpFromInvite(invited.page, inviteUrl, invitedUser);
      await expect(invited.page).not.toHaveURL(/\/auth/, { timeout: 10_000 });

      const joinedMember = await waitForMember(page, company.id, invitedUser.email);

      await setMemberRole(page, companyPrefix, invitedUser.email, "viewer");
      await waitForMemberRole(page, company.id, joinedMember.id, "viewer");

      await invited.page.goto(`${BASE}/${companyPrefix}/company/settings/invites`);
      await expect(
        invited.page.getByText("You do not have permission to manage company invites.")
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        invited.page.getByRole("button", { name: "Create SPS invite" })
      ).toHaveCount(0);

      const forbiddenInviteRes = await sessionJsonRequest(
        invited.page,
        `${BASE}/api/companies/${company.id}/invites`,
        {
          method: "POST",
          data: {
            allowedJoinTypes: "human",
            humanRole: "viewer",
          },
        }
      );
      expect(forbiddenInviteRes.status).toBe(403);
    } finally {
      await invited.context.close();
    }

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required for SPS Node command E2E");
    // The Core stays independently testable. The SPS product harness supplies
    // its Desktop Node module and thereby enables this extra end-to-end leg.
    if (!SPS_DESKTOP_NODE_MODULE_PATH) return;
    const desktopNode = await loadDesktopNodeClient();
    const nodeRunId = Date.now();
    const nodeOwner: HumanUser = {
      name: "Node Owner",
      email: `node-owner-${nodeRunId}@paperclip.local`,
      password: "paperclip-node-owner-password",
    };
    const nodeInviteUrl = await createAuthenticatedInvite(page, companyPrefix);
    const nodeOwnerSession = await newPage(browser);
    try {
      await signUpFromInvite(nodeOwnerSession.page, nodeInviteUrl, nodeOwner);
      await waitForMember(page, company.id, nodeOwner.email);
      const boardApiToken = await authorizeDesktopNode(desktopNode, nodeOwnerSession.page, company.id);
      const identity = desktopNode.createNodeIdentity();
      const registeredNode = await desktopNode.registerSpsNode({
        hubUrl: BASE,
        companyId: company.id,
        identity,
        displayName: "SPS Node E2E",
        platform: process.platform,
        appVersion: "e2e",
        capabilities: [{ kind: "agy_cli", label: "Agy CLI test transport", version: "e2e" }],
        accessToken: boardApiToken,
      });
      await desktopNode.sendSpsNodeHeartbeat({
        hubUrl: BASE,
        nodeId: registeredNode.id,
        identity,
        accessToken: boardApiToken,
      });

      const approved = await sessionJsonRequest(page, `${BASE}/api/sps-nodes/${registeredNode.id}/approve`, {
        method: "POST",
      });
      expect(approved.ok, `node approval returned ${approved.status}`).toBe(true);

      const db = createDb(databaseUrl);
      try {
        const pendingAgent = await db
          .insert(agents)
          .values({
            companyId: company.id,
            name: "Pending Node Worker",
            role: "worker",
            status: "pending_approval",
            adapterType: "sps_agy_local",
            adapterConfig: { command: "agy", model: "auto" },
          })
          .returning()
          .then((rows) => rows[0]!);
        const pendingGrant = await sessionJsonRequest(
          page,
          `${BASE}/api/sps-nodes/${registeredNode.id}/agent-grants/${pendingAgent.id}`,
          { method: "PUT" },
        );
        expect(pendingGrant.status).toBe(400);

        const agent = await db
          .insert(agents)
          .values({
            companyId: company.id,
            name: "Node Transport Worker",
            role: "worker",
            status: "idle",
            adapterType: "sps_agy_local",
            adapterConfig: { command: "agy", model: "auto" },
          })
          .returning()
          .then((rows) => rows[0]!);
        const grant = await sessionJsonRequest(page, `${BASE}/api/sps-nodes/${registeredNode.id}/agent-grants/${agent.id}`, {
          method: "PUT",
        });
        expect(grant.ok, `node grant returned ${grant.status}`).toBe(true);

        const target = await resolveSpsNodeExecutionTarget({
          db,
          companyId: company.id,
          agentId: agent.id,
          adapterType: "sps_agy_local",
          heartbeatRunId: null,
          projectId: null,
        });
        expect(target).not.toBeNull();

        const output: string[] = [];
        const nodeExecution = waitForOneSpsNodeCommand({
          hubUrl: BASE,
          nodeId: registeredNode.id,
          identity,
          accessToken: boardApiToken,
          workspace: process.cwd(),
          client: desktopNode,
        });
        const result = await target!.runner.execute({
          command: process.execPath,
          args: ["-e", "process.stdout.write('SPS Node E2E command output\\n')"],
          cwd: process.cwd(),
          env: {},
          stdin: null,
          timeoutMs: NODE_E2E_TIMEOUT_MS,
          onLog: async (_stream, body) => { output.push(body); },
        });
        const executed = await nodeExecution;

        expect(executed.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("SPS Node E2E command output");
        expect(output.join("")).toContain("SPS Node E2E command output");
      } finally {
        await db.$client.end({ timeout: 5 });
      }
    } finally {
      await nodeOwnerSession.context.close();
    }
  });
});
