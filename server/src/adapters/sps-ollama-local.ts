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

export const SPS_OLLAMA_LOCAL_ADAPTER_TYPE = "sps_ollama_local";
const DEFAULT_MODEL = "llama3.2";

const configSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "command",
      label: "Command",
      type: "text",
      default: "ollama",
      hint: "Ollama executable available on the Agent's assigned SPS Desktop Node.",
    },
    {
      key: "model",
      label: "Local model",
      type: "text",
      default: DEFAULT_MODEL,
      hint: "An Ollama model already pulled on the assigned Node, for example qwen2.5-coder:7b.",
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
      key: "extraArgs",
      label: "Extra Arguments",
      type: "textarea",
      hint: "Optional Ollama arguments, one per line or comma-separated.",
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

export async function executeSpsOllamaLocal(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (!adapterExecutionTargetIsSpsNode(executionTarget)) {
    throw new Error("SPS Ollama Local requires an assigned SPS Desktop Node.");
  }

  const command = asString(ctx.config.command, "ollama");
  const model = asString(ctx.config.model, DEFAULT_MODEL);
  if (!model) throw new Error("Configure an Ollama model before running this Agent.");
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
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, { timeoutSec });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const prompt = buildPrompt(ctx);
  const args = ["run", model, ...asStringArray(ctx.config.extraArgs)];
  const effectiveCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ctx.onMeta?.({
    adapterType: SPS_OLLAMA_LOCAL_ADAPTER_TYPE,
    command: resolvedCommand,
    cwd: effectiveCwd,
    commandNotes: [
      `Running Ollama model \"${model}\" on SPS Desktop Node ${executionTarget.nodeLabel}. Model files stay on that computer.`,
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
      ? firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || `Ollama exited with code ${result.exitCode ?? -1}.`
      : null;
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    errorMessage,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    provider: "ollama",
    biller: "local_node",
    model,
    billingType: "unknown",
    costUsd: null,
    resultJson: { stdout: result.stdout, stderr: result.stderr },
    summary: failed ? "" : result.stdout.trim(),
    clearSession: false,
  };
}

export async function testSpsOllamaLocalEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const target = ctx.executionTarget ?? null;
  const command = asString(parseObject(ctx.config).command, "ollama");
  const model = asString(parseObject(ctx.config).model, DEFAULT_MODEL);
  if (!adapterExecutionTargetIsSpsNode(target)) {
    return {
      adapterType: SPS_OLLAMA_LOCAL_ADAPTER_TYPE,
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [{
        code: "sps_ollama_node_required",
        level: "error",
        message: "SPS Ollama Local requires an assigned SPS Desktop Node.",
      }],
    };
  }
  return {
    adapterType: SPS_OLLAMA_LOCAL_ADAPTER_TYPE,
    status: "warn",
    testedAt: new Date().toISOString(),
    checks: [{
      code: "sps_ollama_node_runtime",
      level: "info",
      message: `Ollama command \"${command}\" will run model \"${model}\" on ${describeAdapterExecutionTarget(target)}. Confirm the Node has both Ollama and this model installed.`,
    }],
  };
}

export const spsOllamaLocalAdapter: ServerAdapterModule = {
  type: SPS_OLLAMA_LOCAL_ADAPTER_TYPE,
  execute: executeSpsOllamaLocal,
  testEnvironment: testSpsOllamaLocalEnvironment,
  models: [{ id: DEFAULT_MODEL, label: "Default local model" }],
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: `# SPS Ollama Local\n\nAdapter: ${SPS_OLLAMA_LOCAL_ADAPTER_TYPE}\n\nUse this adapter for Ollama installed on the Agent's assigned SPS Desktop Node. The Node owns its local models, project files, and runtime configuration. Set the exact installed Ollama model name before waking the Agent.`,
  getConfigSchema: () => configSchema,
};
