import { Link } from "@/lib/router";
import type { ActivityEvent, Agent, DashboardSummary, Issue, Project } from "@paperclipai/shared";
import { ArrowRight, Bot, CircleDot, FolderOpen, ListChecks, MessagesSquare, type LucideIcon } from "lucide-react";
import { ActivityRow } from "./ActivityRow";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";
import { StatusIcon } from "./StatusIcon";
import type { CompanyUserProfile } from "../lib/company-members";
import { timeAgo } from "../lib/timeAgo";
import { getSpsDashboardFocusIssues, getSpsTaskStatusLabel } from "../lib/workplane-dashboard";

function DashboardMetric({
  icon: Icon,
  label,
  value,
  detail,
  to,
  id,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  detail: string;
  to: string;
  id: string;
}) {
  return (
    <Link
      to={to}
      data-od-id={id}
      className="group flex min-h-28 flex-col justify-between rounded-lg border border-border bg-card p-4 no-underline transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
      </div>
      <div>
        <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
    </Link>
  );
}

type SpsCoreDashboardProps = {
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
};

export function SpsCoreDashboard({
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
}: SpsCoreDashboardProps) {
  const activeProjects = projects.filter((project) => !project.archivedAt).length;
  const focusIssues = getSpsDashboardFocusIssues(recentIssues);
  const reviewCount = focusIssues.filter((issue) => issue.status === "blocked" || issue.status === "in_review").length;
  const needsReview = reviewCount > 0;

  return (
    <main data-od-id="core-dashboard" className="space-y-6 pb-2">
      <header data-od-id="dashboard-header" className="flex flex-col gap-5 border-b border-border pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl space-y-2">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">SPS Core · 실행 개요</p>
          <div className="space-y-1">
            <h1 data-od-id="dashboard-title" className="text-2xl font-semibold tracking-tight text-foreground">작업 공간</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              지금 확인할 작업과 실행 중인 Agent를 한곳에서 파악하고, 필요한 화면으로 바로 이동합니다.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/projects"
            data-od-id="open-projects"
            className="inline-flex h-11 items-center gap-1.5 rounded-md border border-border bg-background px-3.5 text-sm font-medium no-underline transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            프로젝트 열기
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
          <Link
            to="/agent-rooms"
            data-od-id="open-rooms"
            className="inline-flex h-11 items-center gap-1.5 rounded-md bg-foreground px-3.5 text-sm font-medium text-background no-underline transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Rooms 열기
            <MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </header>

      {hasNoAgents ? (
        <section data-od-id="no-agents-notice" className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/25 dark:bg-amber-950/60 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-foreground">사용 가능한 Agent가 없습니다.</p>
            <p className="mt-0.5 text-xs text-muted-foreground">작업을 실행하려면 먼저 Agent를 추가해야 합니다.</p>
          </div>
          <Link to="/agents/new" data-od-id="add-agent" className="inline-flex min-h-11 shrink-0 items-center font-medium text-amber-800 no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-200">
            Agent 추가
          </Link>
        </section>
      ) : null}

      <section data-od-id="dashboard-metrics" aria-label="현재 상태" className="grid gap-3 sm:grid-cols-3">
        <DashboardMetric id="metric-projects" icon={FolderOpen} label="활성 프로젝트" value={activeProjects} detail="프로젝트별 Rooms와 작업으로 이동" to="/projects" />
        <DashboardMetric id="metric-tasks" icon={ListChecks} label="진행 중인 Task" value={data.tasks.inProgress} detail={`대기 ${data.tasks.open} · 차단 ${data.tasks.blocked}`} to="/issues" />
        <DashboardMetric id="metric-agents" icon={Bot} label="실행 중인 Agent" value={data.agents.running} detail={`사용 가능 ${data.agents.active} · 오류 ${data.agents.error}`} to="/agents/all" />
      </section>

      <section data-od-id="dashboard-workspace" className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(18rem,0.85fr)]">
        <section data-od-id="priority-tasks" aria-labelledby="priority-tasks-heading" className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 id="priority-tasks-heading" className="text-base font-semibold text-foreground">
                  {needsReview ? "주의가 필요한 Task" : "현재 Task"}
                </h2>
                {reviewCount > 0 ? (
                  <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-mono text-xs font-medium text-amber-900 dark:border-amber-500/25 dark:bg-amber-950/60 dark:text-amber-100">
                    확인 필요 {reviewCount}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">차단되었거나 검토가 필요한 작업을 우선순위에 따라 표시합니다.</p>
            </div>
            <Link to="/issues" data-od-id="all-priority-tasks" className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium text-muted-foreground no-underline hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              전체 Task 보기
            </Link>
          </div>
          {focusIssues.length === 0 ? (
            <div className="px-5 py-9">
              <p className="text-sm font-medium text-foreground">지금 확인할 Task가 없습니다.</p>
              <p className="mt-1 text-sm text-muted-foreground">새 작업이 시작되면 이 목록에서 상태와 다음 행동을 바로 확인할 수 있습니다.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {focusIssues.map((issue) => (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  data-od-id={`priority-task-${issue.id}`}
                  className="group flex min-h-20 items-center gap-3 px-5 py-3.5 no-underline transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{issue.title}</span>
                    <span className="mt-1 block font-mono text-xs text-muted-foreground">
                      {issue.identifier ?? issue.id.slice(0, 8)} · {getSpsTaskStatusLabel(issue.status)} · {timeAgo(issue.updatedAt)}
                    </span>
                  </span>
                  <span className="hidden shrink-0 items-center gap-1 text-sm font-medium text-muted-foreground group-hover:text-foreground sm:inline-flex">
                    열기 <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <aside data-od-id="dashboard-context" aria-label="작업 흐름과 최근 활동" className="space-y-5">
          <section data-od-id="workflow-summary" aria-labelledby="workflow-heading" className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="workflow-heading" className="text-base font-semibold text-foreground">작업 흐름</h2>
                <p className="mt-1 text-sm text-muted-foreground">지금 필요한 운영 점검입니다.</p>
              </div>
              <CircleDot className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="mt-4 divide-y divide-border border-y border-border">
              <Link to="/issues" data-od-id="review-tasks" className="flex min-h-11 items-center justify-between gap-3 py-3 text-sm no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="text-muted-foreground">검토 또는 차단된 Task</span>
                <span className="font-mono font-medium text-foreground">{reviewCount}</span>
              </Link>
              <Link to="/agents/all" data-od-id="running-agents" className="flex min-h-11 items-center justify-between gap-3 py-3 text-sm no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="text-muted-foreground">실행 중인 Agent</span>
                <span className="font-mono font-medium text-foreground">{data.agents.running}</span>
              </Link>
              <Link to="/projects" data-od-id="active-projects" className="flex min-h-11 items-center justify-between gap-3 py-3 text-sm no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="text-muted-foreground">진행 중인 프로젝트</span>
                <span className="font-mono font-medium text-foreground">{activeProjects}</span>
              </Link>
            </div>
          </section>

          <section data-od-id="recent-activity" aria-labelledby="activity-heading" className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 id="activity-heading" className="text-base font-semibold text-foreground">최근 활동</h2>
                <p className="mt-1 text-sm text-muted-foreground">실행과 변경 기록입니다.</p>
              </div>
              <Link to="/inbox" data-od-id="open-inbox" className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium text-muted-foreground no-underline hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                받은 편지함
              </Link>
            </div>
            {recentActivity.length === 0 ? (
              <div className="px-5 py-7">
                <p className="text-sm text-muted-foreground">아직 표시할 활동 기록이 없습니다.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {recentActivity.slice(0, 4).map((event) => (
                  <ActivityRow
                    key={event.id}
                    event={event}
                    agentMap={agentMap}
                    userProfileMap={userProfileMap}
                    entityNameMap={entityNameMap}
                    entityTitleMap={entityTitleMap}
                  />
                ))}
              </div>
            )}
          </section>
        </aside>
      </section>

      <section data-od-id="agent-execution">
        <ActiveAgentsPanel
          companyId={companyId}
          title="Agent 실행 현황"
          minRunCount={1}
          cardLimit={3}
          emptyMessage="현재 실행 중이거나 최근 완료된 Agent 작업이 없습니다."
        />
      </section>
    </main>
  );
}
