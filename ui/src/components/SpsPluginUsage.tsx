import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type {
  PluginSpsExecutionSummary,
  PluginSpsUsageAggregateMetric,
} from "@/compat/paperclip/plugin-sdk";
import { ApiError } from "@/api/client";
import { spsExecutionsApi } from "@/api/sps-executions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type UsagePeriod = "24h" | "7d" | "30d";

const PERIOD_MS: Record<UsagePeriod, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

interface UsageWindow {
  from: string;
  to: string;
}

function createUsageWindow(period: UsagePeriod, endMs = Date.now()): UsageWindow {
  return {
    from: new Date(endMs - PERIOD_MS[period]).toISOString(),
    to: new Date(endMs).toISOString(),
  };
}

export function SpsPluginUsage({ companyId, pluginId }: { companyId: string; pluginId: string }) {
  const [period, setPeriod] = useState<UsagePeriod>("24h");
  const [window, setWindow] = useState(() => createUsageWindow("24h"));
  const query = useQuery({
    queryKey: ["sps-executions-summary", companyId, pluginId, window.from, window.to],
    queryFn: ({ signal }) =>
      spsExecutionsApi.summary(companyId, pluginId, { from: window.from, to: window.to, signal }),
    enabled: Boolean(companyId && pluginId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  function selectPeriod(nextPeriod: UsagePeriod) {
    setPeriod(nextPeriod);
    const nextWindow = createUsageWindow(nextPeriod);
    if (nextWindow.from === window.from && nextWindow.to === window.to) {
      void query.refetch();
    } else {
      setWindow(nextWindow);
    }
  }

  function refreshWindow() {
    const nextWindow = createUsageWindow(period);
    if (nextWindow.from === window.from && nextWindow.to === window.to) {
      void query.refetch();
    } else {
      setWindow(nextWindow);
    }
  }

  const forbidden = query.isError && query.error instanceof ApiError && query.error.status === 403;
  const tooManyExecutions = query.isError && query.error instanceof ApiError && query.error.status === 422;

  return (
    <Card data-testid="sps-plugin-usage">
      <CardHeader className="grid-rows-1 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">Execution usage</CardTitle>
            <CardDescription>
              Measured adapter reports, not an invoice. Subscription reference is separate from incremental API cost.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <label className="sr-only" htmlFor="sps-usage-period">Usage time window</label>
            <select
              id="sps-usage-period"
              aria-label="Usage time window"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={period}
              onChange={(event) => selectPeriod(event.target.value as UsagePeriod)}
            >
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
            </select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              aria-label="Refresh execution usage"
              title="Refresh execution usage"
              disabled={query.isFetching}
              onClick={refreshWindow}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Created at (UTC), start inclusive and end exclusive:{" "}
          <time className="font-mono" dateTime={window.from}>{window.from}</time>
          {" – "}
          <time className="font-mono" dateTime={window.to}>{window.to}</time>
        </p>

        {query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">Loading execution usage...</p>
        ) : query.isError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-muted-foreground">
              {forbidden
                ? "Only the local Host can view execution usage."
                : tooManyExecutions
                  ? "Too many executions. Select a shorter time window."
                  : "Execution usage could not be loaded."}
            </p>
            {!forbidden && !tooManyExecutions ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : query.data ? (
          <UsageSummary summary={query.data} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function UsageSummary({ summary }: { summary: PluginSpsExecutionSummary }) {
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Count label="Executions" value={summary.executionCount} />
        <Count label="Terminal" value={summary.terminalCount} />
        <Count label="In flight" value={summary.inFlightCount} />
        <Count label="Unknown phase" value={summary.unknownPhaseCount} />
      </dl>

      {summary.executionCount === 0 ? (
        <p className="text-sm text-muted-foreground">No executions in this time window.</p>
      ) : null}

      <AggregateTable
        title="Tokens"
        description="Unavailable means no aggregate value was available; it is not zero."
        rows={[
          ["Input tokens", summary.tokens.inputTokens],
          ["Cached input tokens", summary.tokens.cachedInputTokens],
          ["Output tokens", summary.tokens.outputTokens],
        ]}
        formatValue={formatTokenValue}
      />

      <AggregateTable
        title="Adapter-reported costs (USD)"
        rows={[
          ["Incremental API", summary.costs.incrementalApi],
          ["Subscription reference", summary.costs.subscriptionReference],
          ["Other", summary.costs.other],
        ]}
        formatValue={formatCostValue}
      />

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-border/50 pt-3 text-sm">
        <span className="text-muted-foreground">Recorded elapsed duration</span>
        <span className="font-mono tabular-nums">{formatDurationValue(summary.duration.totalMs, summary.duration.overflowed)}</span>
        <span className="text-xs text-muted-foreground">
          {formatCount(summary.duration.knownExecutions)} known · {formatCount(summary.duration.unavailableExecutions)} unavailable
        </span>
      </div>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums text-foreground">{formatCount(value)}</dd>
    </div>
  );
}

function AggregateTable({
  title,
  description,
  rows,
  formatValue,
}: {
  title: string;
  description?: string;
  rows: Array<[string, PluginSpsUsageAggregateMetric]>;
  formatValue: (value: number | null, metric: PluginSpsUsageAggregateMetric) => string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      <div className="w-full">
        <table className="w-full table-fixed text-left text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border/50">
              <th scope="col" className="whitespace-normal break-words py-1.5 pr-2 font-medium">Metric</th>
              <th scope="col" className="whitespace-normal break-words px-2 py-1.5 text-right font-medium">Reported</th>
              <th scope="col" className="whitespace-normal break-words px-2 py-1.5 text-right font-medium">Estimated</th>
              <th scope="col" className="whitespace-normal break-words py-1.5 pl-2 text-right font-medium">Unavailable executions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, metric]) => (
              <tr key={label} className="border-b border-border/30 last:border-0">
                <th scope="row" className="whitespace-normal break-words py-1.5 pr-2 font-normal text-muted-foreground">{label}</th>
                <td className="px-2 py-1.5 text-right">
                  <span data-testid="aggregate-value" className="block break-words font-mono tabular-nums">{formatValue(metric.reported, metric)}</span>
                  <span data-testid="aggregate-coverage" className="block break-words text-muted-foreground">{formatCount(metric.reportedExecutions)} executions</span>
                </td>
                <td className="px-2 py-1.5 text-right">
                  <span data-testid="aggregate-value" className="block break-words font-mono tabular-nums">{formatValue(metric.estimated, metric)}</span>
                  <span data-testid="aggregate-coverage" className="block break-words text-muted-foreground">{formatCount(metric.estimatedExecutions)} executions</span>
                </td>
                <td className="whitespace-normal break-words py-1.5 pl-2 text-right font-mono tabular-nums">{formatCount(metric.unavailableExecutions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatCount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "Unknown";
  return value.toLocaleString("en-US");
}

function formatTokenValue(value: number | null, metric: PluginSpsUsageAggregateMetric): string {
  if (value === null) return metric.overflowed ? "Unknown (overflow)" : "Unavailable";
  if (!Number.isSafeInteger(value) || value < 0) return "Unknown (overflow)";
  return value.toLocaleString("en-US");
}

function formatCostValue(value: number | null, metric: PluginSpsUsageAggregateMetric): string {
  if (value === null) return metric.overflowed ? "Unknown (overflow)" : "Unavailable";
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return "Unknown (overflow)";
  if (value > 0 && value < 1e-12) return "<$0.000000000001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 12,
  }).format(value);
}

function formatDurationValue(value: number | null, overflowed: boolean): string {
  if (value === null) return overflowed ? "Unknown (overflow)" : "Unavailable";
  if (!Number.isSafeInteger(value) || value < 0) return "Unknown (overflow)";
  const seconds = value / 1000;
  return `${seconds.toLocaleString("en-US", { maximumFractionDigits: 1 })} s`;
}
