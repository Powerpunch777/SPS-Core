import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import { ArrowRight, Bot, CircleDot, DollarSign, FolderOpen, LayoutDashboard, ListChecks, MessagesSquare, PauseCircle, ShieldCheck, type LucideIcon } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import { Card } from "@/components/ui/card";
import type { ActivityEvent, Agent, DashboardSummary, Issue, Project } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { isWorkplaneModeEnabled } from "../lib/workplane-mode";
import { getSpsDashboardFocusIssues, getSpsTaskStatusLabel } from "../lib/workplane-dashboard";

const DASHBOARD_ACTIVITY_LIMIT = 10;

function SpsHomeMetric({
  icon: Icon,
  label,
  value,
  detail,
  to,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  detail: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="group flex min-h-28 flex-col justify-between rounded-lg border border-border bg-card p-4 no-underline transition-colors hover:bg-accent/45"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </div>
      <div>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </div>
    </Link>
  );
}

function SpsWorkplaneDashboard({
  data,
  projects,
  recentIssues,
  recentActivity,
  agentMap,
  userProfileMap,
  entityNameMap,
  entityTitleMap,
  companyId,
  hasNoAgents,
}: {
  data: DashboardSummary;
  projects: Project[];
  recentIssues: Issue[];
  recentActivity: ActivityEvent[];
  agentMap: Map<string, Agent>;
  userProfileMap: Map<string, CompanyUserProfile>;
  entityNameMap: Map<string, string>;
  entityTitleMap: Map<string, string>;
  companyId: string;
  hasNoAgents: boolean;
}) {
  const activeProjects = projects.filter((project) => !project.archivedAt).length;
  const focusIssues = getSpsDashboardFocusIssues(recentIssues);
  const needsReview = focusIssues.some((issue) => issue.status === "blocked" || issue.status === "in_review");

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">홈</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            프로젝트의 지속적인 논의는 Rooms에서, 유한한 실행 작업은 Tasks에서 관리합니다.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/projects" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium no-underline transition-colors hover:bg-accent">
            프로젝트 열기
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Link to="/agent-rooms" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-sm font-medium text-background no-underline transition-opacity hover:opacity-90">
            Rooms
            <MessagesSquare className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      {hasNoAgents ? (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/25 dark:bg-amber-950/60 sm:flex-row sm:items-center sm:justify-between">
          <span>아직 사용할 Agent가 없습니다. 먼저 팀에 Agent를 추가하세요.</span>
          <Link to="/agents/new" className="font-medium text-amber-800 no-underline hover:underline dark:text-amber-200">Agent 추가</Link>
        </div>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-3">
        <SpsHomeMetric icon={FolderOpen} label="프로젝트" value={activeProjects} detail="프로젝트를 열어 Rooms로 이동" to="/projects" />
        <SpsHomeMetric icon={ListChecks} label="진행 중 Tasks" value={data.tasks.inProgress} detail={`대기 ${data.tasks.open} · 차단 ${data.tasks.blocked}`} to="/issues" />
        <SpsHomeMetric icon={Bot} label="실행 중 Agent" value={data.agents.running} detail={`사용 가능 ${data.agents.active} · 오류 ${data.agents.error}`} to="/agents/all" />
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{needsReview ? "검토가 필요한 Tasks" : "현재 Tasks"}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">차단되었거나 검토가 필요한 작업을 먼저 보여줍니다.</p>
            </div>
            <Link to="/issues" className="text-sm text-muted-foreground hover:text-foreground hover:underline">전체 보기</Link>
          </div>
          {focusIssues.length === 0 ? (
            <Card className="p-5">
              <p className="text-sm text-muted-foreground">현재 확인이 필요한 Task가 없습니다.</p>
            </Card>
          ) : (
            <Card className="overflow-hidden py-0 divide-y divide-border">
              {focusIssues.map((issue) => (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="flex items-center gap-3 px-4 py-3 no-underline transition-colors hover:bg-accent/50"
                >
                  <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{issue.title}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{issue.identifier ?? issue.id.slice(0, 8)} · {getSpsTaskStatusLabel(issue.status)} · {timeAgo(issue.updatedAt)}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>
              ))}
            </Card>
          )}
        </div>

        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">최근 활동</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">최근 발생한 실행과 변경입니다.</p>
            </div>
            <Link to="/inbox" className="text-sm text-muted-foreground hover:text-foreground hover:underline">검토함</Link>
          </div>
          {recentActivity.length === 0 ? (
            <Card className="p-5">
              <p className="text-sm text-muted-foreground">아직 활동 기록이 없습니다.</p>
            </Card>
          ) : (
            <Card className="overflow-hidden py-0 divide-y divide-border">
              {recentActivity.slice(0, 5).map((event) => (
                <ActivityRow
                  key={event.id}
                  event={event}
                  agentMap={agentMap}
                  userProfileMap={userProfileMap}
                  entityNameMap={entityNameMap}
                  entityTitleMap={entityTitleMap}
                />
              ))}
            </Card>
          )}
        </div>
      </section>

      <ActiveAgentsPanel
        companyId={companyId}
        title="최근 Agent 실행"
        minRunCount={1}
        cardLimit={3}
        emptyMessage="현재 실행 중이거나 최근에 끝난 Agent 작업이 없습니다."
      />
    </div>
  );
}

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const workplaneMode = isWorkplaneModeEnabled();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: workplaneMode ? "홈" : "Dashboard" }]);
  }, [setBreadcrumbs, workplaneMode]);

  const dashboardQueryKey = queryKeys.dashboard(selectedCompanyId!);
  const sharedDashboard = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "dashboard",
    queryKey: dashboardQueryKey,
    enabled: !!selectedCompanyId,
  });
  const { data, isLoading, error, dataUpdatedAt: dashboardUpdatedAt } = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  usePublishSharedQueryData(sharedDashboard, data, dashboardUpdatedAt);

  const activityQueryKey = [...queryKeys.activity(selectedCompanyId!), { limit: DASHBOARD_ACTIVITY_LIMIT }] as const;
  const sharedActivity = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: `activity:limit:${DASHBOARD_ACTIVITY_LIMIT}`,
    queryKey: activityQueryKey,
    enabled: !!selectedCompanyId,
  });
  const { data: activity, dataUpdatedAt: activityUpdatedAt } = useQuery({
    queryKey: activityQueryKey,
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    enabled: !!selectedCompanyId,
  });
  usePublishSharedQueryData(sharedActivity, activity, activityUpdatedAt);

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;

    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);

    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }

    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }

    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    for (const id of newIds) seen.add(id);

    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to SPS. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  if (workplaneMode && data) {
    return (
      <div className="space-y-6">
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        <SpsWorkplaneDashboard
          data={data}
          projects={projects ?? []}
          recentIssues={recentIssues}
          recentActivity={recentActivity}
          agentMap={agentMap}
          userProfileMap={userProfileMap}
          entityNameMap={entityNameMap}
          entityTitleMap={entityTitleMap}
          companyId={selectedCompanyId}
          hasNoAgents={hasNoAgents}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-(image:--gradient-extract-1) px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-950 dark:text-red-50">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-900/70 dark:text-red-100/70">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-900 dark:text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
            <MetricCard
              icon={Bot}
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label="Agents Enabled"
              to="/agents"
              description={
                <span>
                  {data.agents.running} running{", "}
                  {data.agents.paused} paused{", "}
                  {data.agents.error} errors
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Tasks In Progress"
              to="/issues"
              description={
                <span>
                  {data.tasks.open} open{", "}
                  {data.tasks.blocked} blocked
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(data.costs.monthSpendCents)}
              label="Month Spend"
              to="/costs"
              description={
                <span>
                  {data.costs.monthBudgetCents > 0
                    ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                    : "Unlimited budget"}
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label="Pending Approvals"
              to="/approvals"
              description={
                <span>
                  {data.budgets.pendingApprovals > 0
                    ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
                    : "Awaiting board review"}
                </span>
              }
            />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart activity={data.runActivity} />
            </ChartCard>
            <ChartCard title="Tasks by Priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Tasks by Status" subtitle="Last 14 days">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate" subtitle="Last 14 days">
              <SuccessRateChart activity={data.runActivity} />
            </ChartCard>
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            // design-allow(card-pattern): class-string prop consumed by the plugin outlet; a component can't be passed here (C5a Run 3)
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Recent Activity
                </h3>
                <Card className="block py-0 divide-y divide-border overflow-hidden">
                  {recentActivity.map((event) => (
                    <ActivityRow
                      key={event.id}
                      event={event}
                      agentMap={agentMap}
                      userProfileMap={userProfileMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                      className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                    />
                  ))}
                </Card>
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Recent Tasks
              </h3>
              {recentIssues.length === 0 ? (
                <Card className="block p-4">
                  <p className="text-sm text-muted-foreground">No tasks yet.</p>
                </Card>
              ) : (
                <Card className="block py-0 divide-y divide-border overflow-hidden">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        {/* Status icon - left column on mobile */}
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                        </span>

                        {/* Right column on mobile: title + metadata stacked */}
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} /></span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {issue.assigneeAgentId && (() => {
                              const name = agentName(issue.assigneeAgentId);
                              return name
                                ? <span className="hidden sm:inline-flex"><Identity name={name} size="sm" /></span>
                                : null;
                            })()}
                            <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(issue.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </Card>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
