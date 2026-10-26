import { Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { ConferenceRoomChatGate } from "./components/ConferenceRoomChatGate";
import { PipelinesExperimentalGate } from "./components/PipelinesExperimentalGate";
import { CasesExperimentalGate } from "./components/CasesExperimentalGate";
import { CloudAccessGate } from "./components/CloudAccessGate";
import { useCompany } from "./context/CompanyContext";
import { useDialogActions, useDialogState } from "./context/DialogContext";
import { loadLastInboxTab } from "./lib/inbox";
import {
  isOnboardingWizardActive,
  shouldRedirectCompanylessRouteToOnboarding,
} from "./lib/onboarding-route";
import { normalizeRememberedInstanceSettingsPath } from "./lib/instance-settings";
import { isWorkplaneModeEnabled } from "./lib/workplane-mode";
import { isSpsCoreBaselineModeEnabled } from "./lib/sps-core-baseline-mode";
import { isSpsBasicModeEnabled } from "./lib/sps-basic-mode";
import { workspaceShellRoute } from "./lib/workspace-shell-route";
import { AGENT_FILTER_TABS } from "./lib/agent-filter-tabs";
import { lazyNamed } from "./lib/lazy-named";

const SpsWorkspaceLayout = lazyNamed(() => import("./components/SpsWorkspaceLayout"), "SpsWorkspaceLayout");
const SpsEmptyWorkspace = lazyNamed(() => import("./pages/SpsEmptyWorkspace"), "SpsEmptyWorkspace");
const OnboardingWizardVariant = lazyNamed(
  () => import("./components/OnboardingWizardVariant"),
  "OnboardingWizardVariant",
);
const CompanySettingsPluginPage = lazyNamed(
  () => import("./pages/CompanySettingsPluginPage"),
  "CompanySettingsPluginPage",
);
const SpsNodes = lazyNamed(() => import("./pages/SpsNodes"), "SpsNodes");
const PluginManager = lazyNamed(() => import("./pages/PluginManager"), "PluginManager");
const PluginSettings = lazyNamed(() => import("./pages/PluginSettings"), "PluginSettings");
const PluginPage = lazyNamed(() => import("./pages/PluginPage"), "PluginPage");
const NewAgent = lazyNamed(() => import("./pages/NewAgent"), "NewAgent");
const AuthPage = lazyNamed(() => import("./pages/Auth"), "AuthPage");
const BoardClaimPage = lazyNamed(() => import("./pages/BoardClaim"), "BoardClaimPage");
const CliAuthPage = lazyNamed(() => import("./pages/CliAuth"), "CliAuthPage");
const InviteLandingPage = lazyNamed(
  () => import("./pages/InviteLanding"),
  "InviteLandingPage",
);
const SpsJoinPage = lazyNamed(() => import("./pages/SpsJoin"), "SpsJoinPage");
const NotFoundPage = lazyNamed(() => import("./pages/NotFound"), "NotFoundPage");
const SpsCoreWorkspaceHome = lazyNamed(
  () => import("./pages/SpsCoreWorkspaceHome"),
  "SpsCoreWorkspaceHome",
);
const SpsWorkspaceInbox = lazyNamed(
  () => import("./pages/SpsWorkspaceInbox"),
  "SpsWorkspaceInbox",
);
const SpsCoreAssistantDetail = lazyNamed(
  () => import("./pages/SpsCoreAssistantDetail"),
  "SpsCoreAssistantDetail",
);
const SpsCoreHostSettings = lazyNamed(
  () => import("./pages/SpsCoreHostSettings"),
  "SpsCoreHostSettings",
);
const SpsCoreAgents = lazyNamed(() => import("./pages/SpsCoreAgents"), "SpsCoreAgents");
const SpsModelConnections = lazyNamed(() => import("./pages/SpsModelConnections"), "SpsModelConnections");
const SpsCoreWorkspaceSources = lazyNamed(
  () => import("./pages/SpsCoreWorkspaceSources"),
  "SpsCoreWorkspaceSources",
);
const SpsCoreTeamAccess = lazyNamed(
  () => import("./pages/SpsCoreTeamAccess"),
  "SpsCoreTeamAccess",
);
const SpsCoreServerSettings = lazyNamed(
  () => import("./pages/SpsCoreServerSettings"),
  "SpsCoreServerSettings",
);
const Cases = lazyNamed(() => import("./pages/Cases"), "Cases");
const CaseDetail = lazyNamed(() => import("./pages/CaseDetail"), "CaseDetail");
const Dashboard = lazyNamed(() => import("./pages/Dashboard"), "Dashboard");
const DashboardLive = lazyNamed(() => import("./pages/DashboardLive"), "DashboardLive");
const Timeline = lazyNamed(() => import("./pages/Timeline"), "Timeline");
const Companies = lazyNamed(() => import("./pages/Companies"), "Companies");
const Agents = lazyNamed(() => import("./pages/Agents"), "Agents");
const AgentDetail = lazyNamed(() => import("./pages/AgentDetail"), "AgentDetail");
const Projects = lazyNamed(() => import("./pages/Projects"), "Projects");
const ProjectDetail = lazyNamed(() => import("./pages/ProjectDetail"), "ProjectDetail");
const ProjectWorkspaceDetail = lazyNamed(
  () => import("./pages/ProjectWorkspaceDetail"),
  "ProjectWorkspaceDetail",
);
const Workspaces = lazyNamed(() => import("./pages/Workspaces"), "Workspaces");
const Issues = lazyNamed(() => import("./pages/Issues"), "Issues");
const Search = lazyNamed(() => import("./pages/Search"), "Search");
const IssueDetail = lazyNamed(() => import("./pages/IssueDetail"), "IssueDetail");
const IssueChatLongThreadPerf = lazyNamed(
  () => import("./pages/IssueChatLongThreadPerf"),
  "IssueChatLongThreadPerf",
);
const Routines = lazyNamed(() => import("./pages/Routines"), "Routines");
const Learnings = lazyNamed(() => import("./pages/Pipelines"), "Learnings");
const PipelineItemDetail = lazyNamed(
  () => import("./pages/Pipelines"),
  "PipelineItemDetail",
);
const PipelineItemLegacyRedirect = lazyNamed(
  () => import("./pages/Pipelines"),
  "PipelineItemLegacyRedirect",
);
const Pipelines = lazyNamed(() => import("./pages/Pipelines"), "Pipelines");
const ReviewQueue = lazyNamed(() => import("./pages/Pipelines"), "ReviewQueue");
const PipelineSettings = lazyNamed(
  () => import("./pages/PipelineSettings"),
  "PipelineSettings",
);
const RoutineDetail = lazyNamed(() => import("./pages/RoutineDetail"), "RoutineDetail");
const UserProfile = lazyNamed(() => import("./pages/UserProfile"), "UserProfile");
const ExecutionWorkspaceDetail = lazyNamed(
  () => import("./pages/ExecutionWorkspaceDetail"),
  "ExecutionWorkspaceDetail",
);
const Goals = lazyNamed(() => import("./pages/Goals"), "Goals");
const Artifacts = lazyNamed(() => import("./pages/Artifacts"), "Artifacts");
const GoalDetail = lazyNamed(() => import("./pages/GoalDetail"), "GoalDetail");
const Approvals = lazyNamed(() => import("./pages/Approvals"), "Approvals");
const ApprovalDetail = lazyNamed(
  () => import("./pages/ApprovalDetail"),
  "ApprovalDetail",
);
const Costs = lazyNamed(() => import("./pages/Costs"), "Costs");
const Activity = lazyNamed(() => import("./pages/Activity"), "Activity");
const Inbox = lazyNamed(() => import("./pages/Inbox"), "Inbox");
const WhatNeedsMe = lazyNamed(() => import("./pages/WhatNeedsMe"), "WhatNeedsMe");
const BoardChat = lazyNamed(() => import("./pages/BoardChat"), "BoardChat");
const CompanySettings = lazyNamed(
  () => import("./pages/CompanySettings"),
  "CompanySettings",
);
const CompanyEnvironments = lazyNamed(
  () => import("./pages/CompanyEnvironments"),
  "CompanyEnvironments",
);
const CloudUpstream = lazyNamed(() => import("./pages/CloudUpstream"), "CloudUpstream");
const CloudUpstreamUxLab = lazyNamed(
  () => import("./pages/CloudUpstreamUxLab"),
  "CloudUpstreamUxLab",
);
const BootstrapSetupUxLab = lazyNamed(
  () => import("./pages/BootstrapSetupUxLab"),
  "BootstrapSetupUxLab",
);
const ResponsibleUserDenialUxLab = lazyNamed(
  () => import("./pages/ResponsibleUserDenialUxLab"),
  "ResponsibleUserDenialUxLab",
);
const CompanyAccess = lazyNamed(() => import("./pages/CompanyAccess"), "CompanyAccess");
const CompanyAccessLegacyRoute = lazyNamed(
  () => import("./pages/CompanyAccess"),
  "CompanyAccessLegacyRoute",
);
const CompanyInvites = lazyNamed(() => import("./pages/CompanyInvites"), "CompanyInvites");
const CompanyProjectSources = lazyNamed(
  () => import("./pages/CompanyProjectSources"),
  "CompanyProjectSources",
);
const CompanySkills = lazyNamed(() => import("./pages/CompanySkills"), "CompanySkills");
const SkillStudio = lazyNamed(() => import("./pages/SkillStudio"), "SkillStudio");
const Secrets = lazyNamed(() => import("./pages/Secrets"), "Secrets");
const CompanyExport = lazyNamed(() => import("./pages/CompanyExport"), "CompanyExport");
const CompanyImport = lazyNamed(() => import("./pages/CompanyImport"), "CompanyImport");
const DesignGuide = lazyNamed(() => import("./pages/DesignGuide"), "DesignGuide");
const InstanceGeneralSettings = lazyNamed(
  () => import("./pages/InstanceGeneralSettings"),
  "InstanceGeneralSettings",
);
const InstanceAccess = lazyNamed(() => import("./pages/InstanceAccess"), "InstanceAccess");
const InstanceSettings = lazyNamed(() => import("./pages/InstanceSettings"), "InstanceSettings");
const InstanceExperimentalSettings = lazyNamed(
  () => import("./pages/InstanceExperimentalSettings"),
  "InstanceExperimentalSettings",
);
const ProfileSettings = lazyNamed(() => import("./pages/ProfileSettings"), "ProfileSettings");
const AdapterManager = lazyNamed(() => import("./pages/AdapterManager"), "AdapterManager");
const OrgChart = lazyNamed(() => import("./pages/OrgChart"), "OrgChart");
const JoinRequestQueue = lazyNamed(
  () => import("./pages/JoinRequestQueue"),
  "JoinRequestQueue",
);

function coreBaselineRoutes() {
  return (
    <>
      <Route index element={<Navigate to="/dashboard" replace />} />
      <Route path="dashboard" element={<SpsCoreWorkspaceHome />} />
      <Route path="inbox" element={<SpsWorkspaceInbox />} />
      <Route path="assistants/new" element={<NewAgent />} />
      <Route path="assistants/:agentId" element={<SpsCoreAssistantDetail />} />
      <Route path="assistants/:agentId/:tab" element={<SpsCoreAssistantDetail />} />
      <Route path="company/settings" element={<SpsCoreHostSettings />} />
      <Route path="company/settings/agents" element={<SpsCoreAgents />} />
      <Route path="company/settings/secrets" element={<Secrets />} />
      <Route path="company/settings/instance/model-connections" element={<SpsModelConnections />} />
      <Route path="company/settings/workspace-appearance" element={<Navigate to="/company/settings/instance/plugins" replace />} />
      <Route path="company/settings/sps-server" element={<SpsCoreServerSettings />} />
      <Route path="company/settings/team" element={<SpsCoreTeamAccess />} />
      <Route path="company/settings/nodes" element={<SpsNodes />} />
      <Route path="company/settings/project-sources" element={<SpsCoreWorkspaceSources />} />
      <Route path="company/settings/instance/plugins" element={<PluginManager />} />
      <Route path="company/settings/instance/plugins/:pluginId" element={<PluginSettings />} />
      <Route path="company/settings/:settingsRoutePath/*" element={<CompanySettingsPluginPage />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route path=":pluginRoutePath" element={<PluginPage />} />
      <Route path=":pluginRoutePath/*" element={<PluginPage />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </>
  );
}

function boardRoutes() {
  if (isSpsCoreBaselineModeEnabled()) {
    return coreBaselineRoutes();
  }
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="dashboard/live" element={<DashboardLive />} />
      <Route path="timeline" element={<Timeline />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="company/settings/sps-server" element={<SpsCoreServerSettings />} />
      <Route path="company/settings/environments" element={<Navigate to="/company/settings/instance/environments" replace />} />
      <Route path="company/settings/cloud-upstream" element={<CloudUpstream />} />
      <Route path="company/settings/members" element={<CompanyAccess />} />
      <Route path="company/settings/access" element={<CompanyAccessLegacyRoute />} />
      <Route path="company/settings/cloud-upstream" element={<CloudUpstream />} />
      <Route path="company/settings/invites" element={<CompanyInvites />} />
      <Route path="company/settings/nodes" element={<SpsNodes />} />
      <Route path="company/settings/project-sources" element={<CompanyProjectSources />} />
      <Route path="company/export/*" element={<CompanyExport />} />
      <Route path="company/import" element={<CompanyImport />} />
      <Route path="company/settings/secrets" element={<Secrets />} />
      <Route path="company/settings/instance/model-connections" element={<SpsModelConnections />} />
      <Route path="company/settings/instance" element={<Navigate to="general" replace />} />
      <Route path="company/settings/instance/profile" element={<ProfileSettings />} />
      <Route path="company/settings/instance/general" element={<InstanceGeneralSettings />} />
      <Route path="company/settings/instance/environments" element={<CompanyEnvironments />} />
      <Route path="company/settings/instance/environments/new" element={<CompanyEnvironments mode="create" />} />
      <Route path="company/settings/instance/environments/:environmentId/edit" element={<CompanyEnvironments mode="edit" />} />
      <Route path="company/settings/instance/access" element={<InstanceAccess />} />
      <Route path="company/settings/instance/heartbeats" element={<InstanceSettings />} />
      <Route path="company/settings/instance/experimental" element={<InstanceExperimentalSettings />} />
      <Route path="company/settings/instance/plugins" element={<PluginManager />} />
      <Route path="company/settings/instance/plugins/:pluginId" element={<PluginSettings />} />
      <Route path="company/settings/instance/adapters" element={<AdapterManager />} />
      <Route path="company/settings/:settingsRoutePath/*" element={<CompanySettingsPluginPage />} />
      <Route path="skills/studio" element={<SkillStudio />} />
      <Route path="skills/studio/new" element={<SkillStudio />} />
      <Route path="skills/studio/:skillId" element={<SkillStudio />} />
      <Route path="skills/:skillId/studio" element={<LegacySkillStudioRedirect />} />
      <Route path="skills/*" element={<CompanySkills />} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route
        path="org"
        element={isWorkplaneModeEnabled() ? <Navigate to="../agents/all" replace /> : <OrgChart />}
      />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      {AGENT_FILTER_TABS.map((tab) => (
        <Route key={tab} path={`agents/${tab}`} element={<Agents />} />
      ))}
      <Route path="agents/new" element={<NewAgent />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
      <Route path="projects/:projectId/workspaces/:workspaceId" element={<ProjectWorkspaceDetail />} />
      <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
      <Route path="projects/:projectId/configuration" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route path="workspaces" element={<Workspaces />} />
      <Route path="issues" element={<Issues />} />
      <Route path="search" element={<Search />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      {import.meta.env.DEV ? (
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
      ) : null}
      <Route path="routines" element={<Routines />} />
      <Route
        path="cases"
        element={<CasesExperimentalGate><Cases /></CasesExperimentalGate>}
      />
      <Route
        path="cases/:caseIdentifier"
        element={<CasesExperimentalGate><CaseDetail /></CasesExperimentalGate>}
      />
      <Route
        path="review-queue"
        element={<PipelinesExperimentalGate><ReviewQueue /></PipelinesExperimentalGate>}
      />
      <Route
        path="learnings"
        element={<PipelinesExperimentalGate><Learnings /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/add"
        element={<PipelinesExperimentalGate><Pipelines /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/settings"
        element={<PipelinesExperimentalGate><PipelineSettings /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/items/:caseId"
        element={<PipelinesExperimentalGate><PipelineItemDetail /></PipelinesExperimentalGate>}
      />
      <Route
        path="pipelines/:pipelineId/cases/:caseId"
        element={<PipelinesExperimentalGate><PipelineItemLegacyRedirect /></PipelinesExperimentalGate>}
      />
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      <Route path="routines/:routineId/:section" element={<RoutineDetail />} />
      <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/services" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/configuration" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/issues" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/routines" element={<ExecutionWorkspaceDetail />} />
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="artifacts" element={<Artifacts />} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="costs" element={<Costs />} />
      <Route path="activity" element={<Activity />} />
      {/* Conference Room Chat surfaces (PAP-136/PAP-137): routes stay
          registered but redirect to the company home while the experimental
          flag is off. The board-level `artifacts` mount below is the new
          conference-room one; the master-level mount above it still serves
          `/artifacts` in both modes. */}
      <Route element={<ConferenceRoomChatGate />}>
        <Route path="board-chat" element={<BoardChat />} />
        <Route path="artifacts" element={<Artifacts />} />
      </Route>
      <Route path="decisions" element={<WhatNeedsMe />} />
      <Route path="inbox" element={<InboxRootRedirect />} />
      <Route path="inbox/mine" element={<Inbox />} />
      <Route path="inbox/recent" element={<Inbox />} />
      <Route path="inbox/unread" element={<Inbox />} />
      <Route path="inbox/blocked" element={<Inbox />} />
      <Route path="inbox/all" element={<Inbox />} />
      <Route path="inbox/requests" element={<JoinRequestQueue />} />
      <Route path="inbox/new" element={<Navigate to="/inbox/mine" replace />} />
      <Route path="u/:userSlug" element={<UserProfile />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="instance/settings/adapters" element={<AdapterManager />} />
      {/* A page contribution can be its own route root (for example
          /SPS/agent-rooms) or own child paths. React Router does not treat
          the trailing splat as an empty segment in every base-path mode, so
          both forms must be registered explicitly. */}
      <Route path=":pluginRoutePath" element={<PluginPage />} />
      <Route path=":pluginRoutePath/*" element={<PluginPage />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

function InboxRootRedirect() {
  return <Navigate to={`/inbox/${loadLastInboxTab()}`} replace />;
}

function LegacySkillStudioRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();
  const { companyPrefix, skillId } = useParams<{ companyPrefix?: string; skillId?: string }>();

  if (loading) return null;

  const targetCompany =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  if (!targetCompany || !skillId) {
    return <Navigate to="/skills/studio" replace />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}/skills/studio/${encodeURIComponent(skillId)}${location.search}${location.hash}`}
      replace
    />
  );
}

function LegacySettingsRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  const normalizedPath = normalizeRememberedInstanceSettingsPath(
    `${location.pathname}${location.search}${location.hash}`,
  );

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${normalizedPath}`}
      replace
    />
  );
}

function OnboardingRoutePage() {
  const { companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  // The OnboardingWizard auto-opens on this route (and can also be opened
  // explicitly). While it is showing it covers the whole screen, so the
  // launcher card below must not stay interactive behind it — otherwise users
  // can tab/click through to the form behind the modal (PAP-52). The launcher
  // only needs to render as a re-entry point once the wizard is dismissed.
  if (isOnboardingWizardActive({ onboardingOpen, routeDismissed: onboardingRouteDismissed })) {
    return null;
  }
  const matchedCompany = companyPrefix
    ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()) ?? null
    : null;

  const title = matchedCompany
    ? `Add another agent to ${matchedCompany.name}`
    : companies.length > 0
      ? "Create another company"
      : "Create your first company";
  const description = matchedCompany
    ? "Run onboarding again to add an agent and a starter task for this company."
    : companies.length > 0
      ? "Run onboarding again to create another company and seed its first agent."
      : "Get started by creating a company and your first agent.";

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          <Button
            onClick={() =>
              matchedCompany
                ? openOnboarding({ initialStep: 2, companyId: matchedCompany.id })
                : openOnboarding()
            }
          >
            {matchedCompany ? "Add Agent" : "Start Onboarding"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading, error, reloadCompanies } = useCompany();
  const location = useLocation();
  const targetCompany = selectedCompany ?? companies[0] ?? null;
  const coreBaseline = isSpsBasicModeEnabled() && isSpsCoreBaselineModeEnabled() && !isWorkplaneModeEnabled();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (coreBaseline && error) {
    return <SpsEmptyWorkspace workspaceName="Workspace" status="unavailable" onRetry={() => void reloadCompanies()} />;
  }

  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  const target = coreBaseline ? `/${targetCompany.issuePrefix}` : workspaceShellRoute(null, targetCompany.issuePrefix);
  return <Navigate to={target} replace />;
}

function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function NoCompaniesStartPage() {
  const { openOnboarding } = useDialogActions();
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {t("app.noCompanies.title", { defaultValue: "Create your first company" })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("app.noCompanies.description", { defaultValue: "Get started by creating a company." })}
        </p>
        <div className="mt-4">
          <Button onClick={() => openOnboarding()}>
            {t("app.noCompanies.newCompany", { defaultValue: "New Company" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function RouteLoadingFallback() {
  return (
    <div
      className="mx-auto max-w-xl py-10 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      Loading workspace...
    </div>
  );
}

export function App() {
  return (
    <>
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route path="auth" element={<AuthPage />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />
        <Route path="join" element={<SpsJoinPage />} />
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
        <Route path="ux-lab/cloud-upstream" element={<CloudUpstreamUxLab />} />
        <Route path="ux-lab/bootstrap-setup" element={<BootstrapSetupUxLab />} />
        <Route path="ux-lab/responsible-user-denial" element={<ResponsibleUserDenialUxLab />} />

        <Route element={<CloudAccessGate />}>
          <Route index element={<CompanyRootRedirect />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="instance" element={<LegacySettingsRedirect />} />
          <Route path="instance/settings" element={<LegacySettingsRedirect />} />
          <Route path="instance/settings/*" element={<LegacySettingsRedirect />} />
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="routines" element={<UnprefixedBoardRedirect />} />
          <Route path="routines/:routineId" element={<UnprefixedBoardRedirect />} />
          <Route path="review-queue" element={<UnprefixedBoardRedirect />} />
          <Route path="learnings" element={<UnprefixedBoardRedirect />} />
          <Route path="cases" element={<UnprefixedBoardRedirect />} />
          <Route path="cases/:caseIdentifier" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/add" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/settings" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/items/:caseId" element={<UnprefixedBoardRedirect />} />
          <Route path="pipelines/:pipelineId/cases/:caseId" element={<UnprefixedBoardRedirect />} />
          <Route path="artifacts" element={<UnprefixedBoardRedirect />} />
          <Route path="decisions" element={<UnprefixedBoardRedirect />} />
          <Route path="u/:userSlug" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio/new" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/studio/:skillId" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/:skillId/studio" element={<LegacySkillStudioRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
          {AGENT_FILTER_TABS.map((tab) => (
            <Route key={tab} path={`agents/${tab}`} element={<UnprefixedBoardRedirect />} />
          ))}
          <Route path="agents/new" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/services" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/routines" element={<UnprefixedBoardRedirect />} />
          <Route path=":companyPrefix" element={<SpsWorkspaceLayout />}>
            {boardRoutes()}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
          </Route>
        </Routes>
      </Suspense>
      <Suspense fallback={null}>
        <OnboardingWizardVariant />
      </Suspense>
    </>
  );
}
