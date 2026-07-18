import type {
  AdapterConfigSchema,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "./types.js";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  adapterExecutionTargetIsSpsNode,
  adapterExecutionTargetRemoteCwd,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";

export const SPS_AGY_LOCAL_ADAPTER_TYPE = "sps_agy_local";
const DEFAULT_MODEL = "auto";

const configSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "command",
      label: "Command",
      type: "text",
      default: "agy",
      hint: "Agy executable available on the assigned SPS Desktop Node.",
    },
    {
      key: "model",
      label: "Model",
      type: "text",
      default: DEFAULT_MODEL,
      hint: "Optional Agy model selector. The Node keeps the account login locally.",
    },
    {
      key: "timeoutSec",
      label: "Timeout Seconds",
      type: "number",
      default: 0,
      hint: "0 uses the SPS Node command limit.",
    },
    {
      key: "graceSec",
      label: "Grace Seconds",
      type: "number",
      default: 20,
      hint: "Seconds to wait during local process termination.",
    },
    {
      key: "sandbox",
      label: "Agy Sandbox",
      type: "toggle",
      default: false,
      hint: "Pass Agy's sandbox flag in addition to SPS Node permissions.",
    },
    {
      key: "extraArgs",
      label: "Extra Arguments",
      type: "textarea",
      hint: "Optional Agy arguments, one per line or comma-separated.",
    },
  ],
};

function firstNonEmptyLine(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function buildPrompt(ctx: AdapterExecutionContext) {
  const promptTemplate = asString(ctx.config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const templateData = {
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    runId: ctx.runId,
    agent: ctx.agent,
    context: ctx.context,
  };
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, {
    resumedSession: Boolean(ctx.runtime.sessionId),
  });
  return joinPromptSections([wakePrompt, renderTemplate(promptTemplate, templateData)]);
}

function buildArgs(input: {
  prompt: string;
  sandbox: boolean;
  extraArgs: string[];
  isSpsNode: boolean;
  context: AdapterExecutionContext["context"];
}) {
  const args = ["--print", input.prompt, "--dangerously-skip-permissions"];
  if (!input.isSpsNode) {
    const workspaces = Array.isArray(input.context.paperclipWorkspaces)
      ? input.context.paperclipWorkspaces
      : [];
    for (const workspace of workspaces) {
      const parsed = parseObject(workspace);
      const cwd = asString(parsed.cwd, "");
      if (cwd) args.push("--add-dir", cwd);
    }
  }
  if (input.sandbox) args.push("--sandbox");
  args.push(...input.extraArgs);
  return args;
}

export async function executeSpsAgyLocal(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const command = asString(ctx.config.command, "agy");
  const model = asString(ctx.config.model, DEFAULT_MODEL);
  const workspaceContext = parseObject(ctx.context.paperclipWorkspace);
  const configuredCwd = asString(ctx.config.cwd, "");
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const env = buildPaperclipEnv(ctx.agent);
  env.PAPERCLIP_RUN_ID = ctx.runId;
  if (model && model !== DEFAULT_MODEL) env.ANTIGRAVITY_MODEL = model;
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(ctx.config.timeoutSec, 0),
  );
  const graceSec = asNumber(ctx.config.graceSec, 20);
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, { timeoutSec });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const prompt = buildPrompt(ctx);
  const args = buildArgs({
    prompt,
    sandbox: asBoolean(ctx.config.sandbox, false),
    extraArgs: asStringArray(ctx.config.extraArgs),
    isSpsNode: adapterExecutionTargetIsSpsNode(executionTarget),
    context: ctx.context,
  });
  const effectiveCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ctx.onMeta?.({
    adapterType: SPS_AGY_LOCAL_ADAPTER_TYPE,
    command: resolvedCommand,
    cwd: effectiveCwd,
    commandNotes: [
      adapterExecutionTargetIsSpsNode(executionTarget)
        ? "Running Agy on the assigned SPS Desktop Node. Provider credentials stay on that Node."
        : "Running Agy in the local SPS Hub environment.",
    ],
    commandArgs: args.map((value, index) => (index === 1 ? `<prompt ${prompt.length} chars>` : value)),
    env: buildInvocationEnvForLogs(env, { runtimeEnv, resolvedCommand }),
    prompt,
    promptMetrics: { promptChars: prompt.length },
    context: ctx.context,
  });
  const result = await runAdapterExecutionTargetProcess(ctx.runId, executionTarget, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onSpawn: ctx.onSpawn,
    onLog: ctx.onLog,
    onRuntimeProgress: ctx.onRuntimeProgress,
  });
  const failed = result.timedOut || (result.exitCode ?? 0) !== 0;
  const errorMessage = result.timedOut
    ? `Timed out after ${timeoutSec > 0 ? timeoutSec : "the SPS Node"} seconds.`
    : failed
      ? firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || `Agy exited with code ${result.exitCode ?? -1}.`
      : null;
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    errorMessage,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    provider: "antigravity",
    biller: "local_account",
    model,
    billingType: "unknown",
    costUsd: null,
    resultJson: { stdout: result.stdout, stderr: result.stderr },
    summary: failed ? "" : result.stdout.trim(),
    clearSession: false,
  };
}

export async function testSpsAgyLocalEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const target = ctx.executionTarget ?? null;
  const command = asString(parseObject(ctx.config).command, "agy");
  const targetLabel = target?.kind === "remote" ? describeAdapterExecutionTarget(target) : "local SPS Hub";
  if (target?.kind === "remote" && !adapterExecutionTargetIsSpsNode(target)) {
    return {
      adapterType: SPS_AGY_LOCAL_ADAPTER_TYPE,
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [{
        code: "sps_agy_node_required",
        level: "error",
        message: "SPS Agy CLI requires an assigned SPS Desktop Node.",
      }],
    };
  }
  return {
    adapterType: SPS_AGY_LOCAL_ADAPTER_TYPE,
    status: "warn",
    testedAt: new Date().toISOString(),
    checks: [{
      code: "sps_agy_node_runtime",
      level: "info",
      message: `Agy command \"${command}\" will run on ${targetLabel}. Use the Node capability list to confirm it is installed.`,
    }],
  };
}

export const spsAgyLocalAdapter: ServerAdapterModule = {
  type: SPS_AGY_LOCAL_ADAPTER_TYPE,
  execute: executeSpsAgyLocal,
  testEnvironment: testSpsAgyLocalEnvironment,
  models: [{ id: DEFAULT_MODEL, label: "Auto" }],
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: `# SPS Agy CLI\n\nAdapter: ${SPS_AGY_LOCAL_ADAPTER_TYPE}\n\nUse this adapter for an Agy installation on the Agent's assigned SPS Desktop Node. The Node owns Agy login state and provider credentials; SPS only sends the task prompt and allowed runtime metadata.\n\nSet model to \`auto\` to let the local Agy account choose, or enter a supported Agy model name.`,
  getConfigSchema: () => configSchema,
};
