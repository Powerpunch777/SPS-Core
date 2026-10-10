import type {
  AdapterConfigSchema,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "./types.js";
import {
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "../compat/paperclip/adapter-runtime.js";
import {
  adapterExecutionTargetIsSpsNode,
  adapterExecutionTargetRemoteCwd,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
} from "../compat/paperclip/adapter-runtime.js";

export const SPS_LM_STUDIO_LOCAL_ADAPTER_TYPE = "sps_lm_studio_local";

const configSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "command",
      label: "Command",
      type: "text",
      default: "lms",
      hint: "LM Studio CLI available on the Agent's assigned SPS Desktop Node.",
    },
    {
      key: "model",
      label: "Local model",
      type: "text",
      hint: "Exact LM Studio model identifier loaded or available on the assigned Node. Check with lms ps or lms ls.",
    },
    {
      key: "keepLoadedSec",
      label: "Keep Loaded Seconds",
      type: "number",
      default: 3600,
      hint: "LM Studio unloads the model after this idle time. Set 0 to use the CLI default.",
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
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, {
    resumedSession: false,
  });
  return joinPromptSections([
    wakePrompt,
    renderTemplate(promptTemplate, {
      agentId: ctx.agent.id,
      companyId: ctx.agent.companyId,
      runId: ctx.runId,
      agent: ctx.agent,
      context: ctx.context,
    }),
  ]);
}

export async function executeSpsLmStudioLocal(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (!adapterExecutionTargetIsSpsNode(executionTarget)) {
    throw new Error("SPS LM Studio Local requires an assigned SPS Desktop Node.");
  }

  const command = asString(ctx.config.command, "lms");
  const model = asString(ctx.config.model, "").trim();
  if (!model) throw new Error("Configure an LM Studio model before running this Agent.");
  const workspaceContext = parseObject(ctx.context.paperclipWorkspace);
  const configuredCwd = asString(ctx.config.cwd, "");
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const env = buildPaperclipEnv(ctx.agent);
  env.PAPERCLIP_RUN_ID = ctx.runId;
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
  const keepLoadedSec = Math.max(0, asNumber(ctx.config.keepLoadedSec, 3600));
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, { timeoutSec });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const prompt = buildPrompt(ctx);
  const args = [
    "chat",
    model,
    "--prompt",
    "Read and follow the complete SPS task context from standard input. Do the requested work, then return a concise final report.",
    ...(keepLoadedSec > 0 ? ["--ttl", String(keepLoadedSec)] : []),
  ];
  const effectiveCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ctx.onMeta?.({
    adapterType: SPS_LM_STUDIO_LOCAL_ADAPTER_TYPE,
    command: resolvedCommand,
    cwd: effectiveCwd,
    commandNotes: [
      `Running LM Studio model \"${model}\" on SPS Desktop Node ${executionTarget.nodeLabel}. The model and any LM Studio credentials remain on that computer.`,
    ],
    commandArgs: args,
    env: buildInvocationEnvForLogs(env, { runtimeEnv, resolvedCommand }),
    prompt,
    promptMetrics: { promptChars: prompt.length },
    context: ctx.context,
  });
  const result = await runAdapterExecutionTargetProcess(ctx.runId, executionTarget, command, args, {
    cwd,
    env,
    stdin: prompt,
    timeoutSec,
    graceSec,
    onLog: ctx.onLog,
    onRuntimeProgress: ctx.onRuntimeProgress,
    onSpawn: ctx.onSpawn,
  });
  const failed = result.timedOut || (result.exitCode ?? 0) !== 0;
  const errorMessage = result.timedOut
    ? `Timed out after ${timeoutSec > 0 ? timeoutSec : "the SPS Node"} seconds.`
    : failed
      ? firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || `LM Studio exited with code ${result.exitCode ?? -1}.`
      : null;
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    errorMessage,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    provider: "lm_studio",
    biller: "local_node",
    model,
    billingType: "unknown",
    costUsd: null,
    resultJson: { stdout: result.stdout, stderr: result.stderr },
    summary: failed ? "" : result.stdout.trim(),
    clearSession: false,
  };
}

export async function testSpsLmStudioLocalEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const target = ctx.executionTarget ?? null;
  const command = asString(parseObject(ctx.config).command, "lms");
  const model = asString(parseObject(ctx.config).model, "").trim();
  if (!adapterExecutionTargetIsSpsNode(target)) {
    return {
      adapterType: SPS_LM_STUDIO_LOCAL_ADAPTER_TYPE,
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [{
        code: "sps_lm_studio_node_required",
        level: "error",
        message: "SPS LM Studio Local requires an assigned SPS Desktop Node.",
      }],
    };
  }
  return {
    adapterType: SPS_LM_STUDIO_LOCAL_ADAPTER_TYPE,
    status: model ? "warn" : "fail",
    testedAt: new Date().toISOString(),
    checks: [{
      code: "sps_lm_studio_node_runtime",
      level: model ? "info" : "error",
      message: model
        ? `LM Studio command \"${command}\" will run model \"${model}\" on ${describeAdapterExecutionTarget(target)}. Confirm it is available with lms ps or lms ls.`
        : "Choose an LM Studio model before waking this Agent.",
    }],
  };
}

export const spsLmStudioLocalAdapter: ServerAdapterModule = {
  type: SPS_LM_STUDIO_LOCAL_ADAPTER_TYPE,
  execute: executeSpsLmStudioLocal,
  testEnvironment: testSpsLmStudioLocalEnvironment,
  models: [],
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: `# SPS LM Studio Local\n\nAdapter: ${SPS_LM_STUDIO_LOCAL_ADAPTER_TYPE}\n\nUse this adapter for LM Studio installed on the Agent's assigned SPS Desktop Node. Set the exact local model identifier from \`lms ps\` or \`lms ls\`. SPS streams the task prompt to LM Studio through standard input, so project files, models, and LM Studio credentials stay on the Node computer.`,
  getConfigSchema: () => configSchema,
};
