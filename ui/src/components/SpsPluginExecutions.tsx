import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { ApiError } from "@/api/client";
import {
  spsExecutionsApi,
  type PluginSpsExecution,
  type PluginSpsExecutionCursor,
  type PluginSpsExecutionLane,
} from "@/api/sps-executions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type LaneFilter = "all" | PluginSpsExecutionLane;
type ExecutionIdentity = { lane: PluginSpsExecutionLane; runId: string };

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_MODEL_PATTERN = /^[a-z0-9][a-z0-9._:/@+-]{0,119}$/i;
const SENSITIVE_MODEL_PATTERN = /^[a-z]:[\\/]|^https?:|\.\.|[^@]+@[^@]+\.[^@]+|^(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza|eyJ)/i;

const RUNTIME_LABELS: Record<string, string> = {
  model_api: "Model API",
  process: "Local process",
  codex_local: "Codex CLI",
  claude_local: "Claude CLI",
  gemini_local: "Gemini CLI",
  opencode_local: "OpenCode CLI",
  pi_local: "Pi CLI",
  agy_cli: "AGY CLI",
  claude_cli: "Claude CLI",
  codex_cli: "Codex CLI",
  gemini_cli: "Gemini CLI",
  lm_studio: "LM Studio",
  ollama: "Ollama",
  opencode_cli: "OpenCode CLI",
  pi_cli: "Pi CLI",
};

const STATUS_LABELS: Record<string, string> = {
  claimed: "Claimed",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  failed: "Failed",
  interrupted: "Interrupted",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  timed_out: "Timed out",
};

const PHASE_LABELS: Record<PluginSpsExecution["phase"], string> = {
  active: "Active",
  cancelled: "Cancelled",
  failed: "Failed",
  interrupted: "Interrupted",
  queued: "Queued",
  stopping: "Stopping",
  succeeded: "Succeeded",
  unknown: "Unknown",
};

const FAILURE_LABELS: Record<NonNullable<PluginSpsExecution["failure"]>["category"], string> = {
  authorization: "Authorization",
  cancelled: "Cancelled",
  configuration: "Configuration",
  execution: "Execution",
  provider_limit: "Provider limit",
  timeout: "Timeout",
  unknown: "Unknown",
};

const COST_BASIS_LABELS: Record<PluginSpsExecution["usage"]["costBasis"], string> = {
  incremental_api: "Incremental API",
  subscription_reference: "Subscription reference",
  unknown: "Unknown",
};

const BILLING_TYPE_LABELS: Record<PluginSpsExecution["usage"]["billingType"], string> = {
  credits: "Credits",
  fixed: "Fixed",
  metered_api: "Metered API",
  subscription_included: "Subscription included",
  subscription_overage: "Subscription overage",
  unknown: "Unknown",
};

function isExecutionLane(value: unknown): value is PluginSpsExecutionLane {
  return value === "node" || value === "agent_session" || value === "model_request";
}

function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

function laneLabel(lane: PluginSpsExecutionLane): string {
  return lane === "node" ? "Node" : lane === "model_request" ? "Model request" : "Agent session";
}

function runtimeLabel(kind: string | null): string {
  return kind && Object.hasOwn(RUNTIME_LABELS, kind) ? RUNTIME_LABELS[kind] : "Unknown runtime";
}

function modelLabel(model: string | null): string | null {
  if (!model || !SAFE_MODEL_PATTERN.test(model) || SENSITIVE_MODEL_PATTERN.test(model) || model === "unknown") return null;
  return model;
}

function statusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : "Unknown status";
}

function formatDate(value: string | null): string {
  if (!value) return "Unknown";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function formatElapsed(value: number | null): string {
  if (!Number.isSafeInteger(value) || value === null || value < 0) return "Unknown";
  return `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
}

function metricValue(value: number | null): string {
  if (!Number.isSafeInteger(value) || value === null || value < 0) return "Unknown";
  return value.toLocaleString();
}

function costValue(execution: PluginSpsExecution): string {
  const value = execution.usage.costUsd.value;
  if (value === null || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return "Unknown";
  if (execution.usage.currency !== "USD") return `${value.toLocaleString()} (currency unknown)`;
  if (value > 0 && value < 0.00000001) return "<$0.00000001";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 8,
  }).format(value);
}

function provenanceLabel(value: string): string {
  if (value === "reported") return "Reported";
  if (value === "estimated") return "Estimated";
  return "Unknown";
}

export function SpsPluginExecutions({ companyId, pluginId }: { companyId: string; pluginId: string }) {
  const [lane, setLane] = useState<LaneFilter>("all");
  const [cursorStack, setCursorStack] = useState<Array<PluginSpsExecutionCursor | null>>([null]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<ExecutionIdentity | null>(null);
  const cursor = cursorStack[cursorStack.length - 1] ?? null;
  const queryLane = lane === "all" ? undefined : lane;
  const query = useQuery({
    queryKey: ["sps-plugin-executions", companyId, pluginId, lane, cursor, refreshKey],
    queryFn: ({ signal }) => spsExecutionsApi.list(companyId, pluginId, {
      limit: 20,
      ...(queryLane ? { lane: queryLane } : {}),
      cursor,
      signal,
    }),
    enabled: Boolean(companyId && pluginId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });

  function changeLane(nextLane: LaneFilter) {
    setLane(nextLane);
    setCursorStack([null]);
    setSelected(null);
  }

  function refresh() {
    setCursorStack([null]);
    setSelected(null);
    setRefreshKey((value) => value + 1);
  }

  function older() {
    if (!query.data?.nextCursor || query.isFetching) return;
    setCursorStack((stack) => [...stack, query.data!.nextCursor]);
    setSelected(null);
  }

  function newer() {
    if (cursorStack.length <= 1 || query.isFetching) return;
    setCursorStack((stack) => stack.slice(0, -1));
    setSelected(null);
  }

  const hostDenied = query.isError && query.error instanceof ApiError && query.error.status === 403;

  return (
    <Card data-testid="sps-plugin-executions">
      <CardHeader className="grid-rows-1 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">Execution history</CardTitle>
            <CardDescription>Recent technical runs for this Plugin.</CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <label className="sr-only" htmlFor="sps-execution-lane">Execution lane</label>
            <select
              id="sps-execution-lane"
              aria-label="Execution lane"
              className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={lane}
              onChange={(event) => changeLane(event.target.value as LaneFilter)}
            >
              <option value="all">All lanes</option>
              <option value="agent_session">Agent session</option>
              <option value="node">Node</option>
              <option value="model_request">Model request</option>
            </select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              aria-label="Refresh execution history"
              title="Refresh execution history"
              disabled={query.isFetching}
              onClick={refresh}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">Loading execution history...</p>
        ) : query.isError ? (
          <p className="text-sm text-muted-foreground" role="alert">
            {hostDenied ? "Only the local Host can view execution history." : "Execution history could not be loaded."}
          </p>
        ) : (
          <>
            {query.data.items.length === 0 ? <p className="text-sm text-muted-foreground">No executions.</p> : null}
            <ul className="divide-y divide-border/50">
              {query.data.items.map((execution) => {
                const validIdentity = isExecutionLane(execution.lane) && isRunId(execution.runId);
                const isSelected = selected?.lane === execution.lane && selected.runId === execution.runId;
                return (
                  <li key={`${execution.lane}:${execution.runId}`} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={execution.phase === "failed" ? "destructive" : "outline"}>
                            {PHASE_LABELS[execution.phase] ?? "Unknown"}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{statusLabel(execution.status)}</span>
                          <span className="text-xs text-muted-foreground">{laneLabel(execution.lane)}</span>
                        </div>
                        <p className="break-all font-mono text-xs text-foreground">
                          {isRunId(execution.runId) ? execution.runId : "Run ID unavailable"}
                        </p>
                        <p className="break-words text-xs text-muted-foreground">
                          {runtimeLabel(execution.runtime.kind)}
                          {modelLabel(execution.runtime.model) ? ` · ${modelLabel(execution.runtime.model)}` : ""}
                          {` · ${formatDate(execution.createdAt)}`}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        disabled={!validIdentity}
                        aria-label={isSelected ? `Close execution ${execution.runId}` : `View execution ${execution.runId}`}
                        aria-expanded={isSelected}
                        onClick={() => setSelected(isSelected ? null : { lane: execution.lane, runId: execution.runId })}
                      >
                        {isSelected ? "Close" : "Details"}
                      </Button>
                    </div>
                    {isSelected && validIdentity ? (
                      <SpsExecutionDetail
                        key={`${companyId}:${pluginId}:${execution.lane}:${execution.runId}`}
                        companyId={companyId}
                        pluginId={pluginId}
                        lane={execution.lane}
                        runId={execution.runId}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3">
              <Button type="button" variant="outline" size="sm" disabled={cursorStack.length <= 1 || query.isFetching} onClick={newer}>
                <ChevronLeft aria-hidden="true" />
                Newer
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={!query.data.nextCursor || query.isFetching} onClick={older}>
                Older
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SpsExecutionDetail({
  companyId,
  pluginId,
  lane,
  runId,
}: {
  companyId: string;
  pluginId: string;
  lane: PluginSpsExecutionLane;
  runId: string;
}) {
  const query = useQuery({
    queryKey: ["sps-plugin-execution-detail", companyId, pluginId, lane, runId],
    queryFn: ({ signal }) => spsExecutionsApi.get(companyId, pluginId, lane, runId, { signal }),
    enabled: isExecutionLane(lane) && isRunId(runId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });
  const hostDenied = query.isError && query.error instanceof ApiError && query.error.status === 403;

  return (
    <section data-testid="sps-execution-detail" aria-label="Execution details" aria-busy={query.isPending} className="mt-3 space-y-3 rounded-md border border-border/50 bg-muted/20 p-3">
      {query.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">Loading details...</p>
      ) : query.isError ? (
        <p className="text-sm text-muted-foreground" role="alert">
          {hostDenied ? "Only the local Host can view execution details." : "Execution details could not be loaded."}
        </p>
      ) : query.data ? (
        <ExecutionFacts execution={query.data} />
      ) : (
        <p className="text-sm text-muted-foreground">Execution details are unavailable.</p>
      )}
    </section>
  );
}

function ExecutionFacts({ execution }: { execution: PluginSpsExecution }) {
  const failureCategory = execution.failure?.category;
  const facts: Array<[string, string]> = [
    ["Run ID", isRunId(execution.runId) ? execution.runId : "Unavailable"],
    ["Lane", isExecutionLane(execution.lane) ? laneLabel(execution.lane) : "Unknown"],
    ["Status", statusLabel(execution.status)],
    ["Phase", PHASE_LABELS[execution.phase] ?? "Unknown"],
    ["Runtime", runtimeLabel(execution.runtime.kind)],
    ["Model", modelLabel(execution.runtime.model) ?? "Unknown"],
    ["Model source", execution.runtime.modelSource === "configured" ? "Host configured" : execution.runtime.modelSource === "reported" ? "Provider or adapter report" : "Unknown"],
    ["Created", formatDate(execution.createdAt)],
    ["Started", formatDate(execution.startedAt)],
    ["Finished", formatDate(execution.finishedAt)],
    ["Elapsed", formatElapsed(execution.elapsedMs)],
    ["Cancellation requested", execution.cancellationRequested === true ? "Yes" : "No"],
    ["Termination", terminationLabel(execution.termination)],
    ["Input tokens", metricDescription(execution.usage.inputTokens)],
    ["Cached input tokens", metricDescription(execution.usage.cachedInputTokens)],
    ["Output tokens", metricDescription(execution.usage.outputTokens)],
    ["Cost", `${costValue(execution)} · ${provenanceLabel(execution.usage.costUsd.provenance)}`],
    ["Cost basis", safeCostBasis(execution.usage.costBasis)],
    ["Billing type", safeBillingType(execution.usage.billingType)],
  ];

  if (failureCategory) {
    facts.push(["Failure category", FAILURE_LABELS[failureCategory] ?? "Unknown"]);
    if (execution.failure?.retrySafety === "requires_review") facts.push(["Retry safety", "Requires review"]);
  }

  return (
    <dl className="grid min-w-0 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
      {facts.map(([label, value]) => (
        <div key={label} className="flex min-w-0 items-baseline justify-between gap-3">
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all text-right font-mono tabular-nums text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function metricDescription(metric: PluginSpsExecution["usage"]["inputTokens"]): string {
  const value = metricValue(metric.value);
  if (value === "Unknown") return value;
  return `${value} · ${provenanceLabel(metric.provenance)}`;
}

function terminationLabel(value: PluginSpsExecution["termination"]): string {
  if (value === "confirmed") return "Confirmed";
  if (value === "pending") return "Pending";
  return value === "not_applicable" ? "Not applicable" : "Unknown";
}

function safeCostBasis(value: string): string {
  return Object.hasOwn(COST_BASIS_LABELS, value) ? COST_BASIS_LABELS[value as keyof typeof COST_BASIS_LABELS] : "Unknown";
}

function safeBillingType(value: string): string {
  return Object.hasOwn(BILLING_TYPE_LABELS, value) ? BILLING_TYPE_LABELS[value as keyof typeof BILLING_TYPE_LABELS] : "Unknown";
}
