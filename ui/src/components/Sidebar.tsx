import {
  Inbox,
  ListChecks,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  Layers,
  GitBranch,
  Package,
  Puzzle,
  Settings,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  MessagesSquare,
  GanttChartSquare,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarStarredProjects } from "./SidebarStarredProjects";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { attentionApi } from "../api/attention";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { accessApi } from "../api/access";
import { workspaceSurfacesApi } from "../api/workspace-surfaces";
import { queryKeys } from "../lib/queryKeys";
import { attentionBadgeCount } from "../lib/attention";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { ProductBrand } from "./ProductBrand";
import { isWorkplaneModeEnabled } from "../lib/workplane-mode";
import { isSpsBasicModeEnabled } from "../lib/sps-basic-mode";
import { isSpsCoreBaselineModeEnabled } from "../lib/sps-core-baseline-mode";

export function Sidebar() {
  const workplaneMode = isWorkplaneModeEnabled();
  const basicMode = isSpsBasicModeEnabled();
  const coreBaselineMode = isSpsCoreBaselineModeEnabled();
  // SPS Desktop's bundled Workplane is intentionally room-first. Keep this
  // product navigation behind the existing runtime profile so generic Core
  // deployments retain their own information architecture.
  const spsWorkplaneShell = basicMode && workplaneMode;
  const spsCoreBaselineShell = basicMode && coreBaselineMode && !workplaneMode;
  const { openNewIssue } = useDialogActions();
  // Every labeled section is collapsible (session-scoped, default open) —
  // one policy across static nav groups and the data-driven sections.
  const [workOpen, setWorkOpen] = useState(true);
  const [companyOpen, setCompanyOpen] = useState(true);
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { isMobile, collapsed, collapseLocked, peeking, toggleCollapsed, setCollapsed } = useSidebar();
  const rail = collapsed && !peeking;
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: spsCoreBaselineShell,
    retry: false,
  });
  const { data: workspaceShell } = useQuery({
    queryKey: queryKeys.workspaceSurfaces.shell(selectedCompanyId ?? ""),
    queryFn: () => workspaceSurfacesApi.getShell(selectedCompanyId!),
    enabled: spsCoreBaselineShell && Boolean(selectedCompanyId),
  });
  const { data: workspaceInbox } = useQuery({
    queryKey: queryKeys.workspaceSurfaces.inbox(selectedCompanyId ?? ""),
    queryFn: () => workspaceSurfacesApi.listInbox(selectedCompanyId!),
    enabled: spsCoreBaselineShell && Boolean(selectedCompanyId),
    refetchInterval: 15_000,
  });
  // A signed-in Desktop Host is represented by an SPS Identity session plus
  // the Desktop-only Host proof. `isCoreHost` is verified by the server for
  // this exact request; database roles and session source are deliberately
  // not used as a proxy for possession of the physical Host.
  const canManageCoreHost = !spsCoreBaselineShell || boardAccess?.isCoreHost === true;
  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);
  const liveRunCount = liveRuns?.length ?? 0;
  const showWorkspacesLink = !basicMode && experimentalSettings?.enableIsolatedWorkspaces === true;
  const showPipelines = !basicMode && experimentalSettings?.enablePipelines === true;
  const goalsLinkPending = !basicMode && experimentalSettings === undefined;
  const showGoalsLink = !basicMode && experimentalSettings?.enableGoalsSidebarLink === true;
  // Decisions (attention home) is an experimental surface (PAP-13481): the nav
  // item is hidden entirely until the flag is enabled (same no-flash pattern as
  // showWorkspacesLink — it defaults hidden, so no placeholder is needed).
  const showDecisions = !basicMode && experimentalSettings?.enableDecisions === true;
  const { data: attentionFeed } = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && showDecisions,
    refetchInterval: 60_000,
  });
  const attentionCount = attentionBadgeCount(attentionFeed);
  const showCases = !basicMode && experimentalSettings?.enableCases === true;
  // Streamlined left navigation (top-level Projects link + starred children) is
  // now the standard product sidebar (PAP-12472). The former experimental
  // opt-out was retired; classic per-project collapsible mode is no longer
  // user-selectable. Kept as a constant so the classic branch below stays as a
  // documented reference until it is fully removed. Routes are unaffected.
  const streamlined = true;
  // Conference Room Chat flag (PAP-136/PAP-137): the Conference Room nav item
  // is a new surface, hidden entirely while the flag is off (same no-flash
  // pattern as showWorkspacesLink above).
  const conferenceRoomChatEnabled = !basicMode && experimentalSettings?.enableConferenceRoomChat === true;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };
  const { slots: workspacePluginPageSlots } = usePluginSlots({
    slotTypes: ["page"],
    companyId: selectedCompanyId,
    enabled: spsCoreBaselineShell && !!selectedCompanyId,
  });
  const workspacePluginPages = useMemo(
    () => workspacePluginPageSlots
      .filter((slot) => Boolean(slot.routePath && selectedCompany?.issuePrefix))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0)),
    [selectedCompany?.issuePrefix, workspacePluginPageSlots],
  );
  const shellNavigation = useMemo(
    () => [...(workspaceShell?.shell?.navigation ?? [])]
      .filter((item) => item.target !== "/dashboard" && item.target !== "/inbox")
      .sort((left, right) => (
        (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
        || left.displayName.localeCompare(right.displayName)
      )),
    [workspaceShell?.shell?.navigation],
  );
  const shellNavigationTargets = useMemo(
    () => new Set(shellNavigation.map((item) => item.target.replace(/\/+$/, ""))),
    [shellNavigation],
  );
  const workspaceUnreadCount = workspaceInbox?.items.filter((item) => item.unread).length ?? 0;

  if (spsCoreBaselineShell) {
    return (
      <aside className="sps-workbench-nav w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
        <div className="sps-workbench-brand flex items-center gap-1 px-3 h-12 shrink-0">
          <ProductBrand compact={rail} className="mr-auto" />
          {!rail && !isMobile && !collapseLocked ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground shrink-0"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => toggleCollapsed()}
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
          ) : null}
        </div>

        <nav className="sps-workbench-nav-body flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 pointer-coarse:gap-3 px-3 py-2">
          <div className="flex flex-col gap-0.5">
            <SidebarCompanyMenu />
          </div>

          <SidebarSection label="Core Workspace">
            <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} />
            <SidebarNavItem
              to="/inbox"
              label="Inbox"
              icon={Inbox}
              badge={workspaceUnreadCount}
              badgeLabel="unread"
            />
          </SidebarSection>

          {shellNavigation.length > 0 || workspacePluginPages.length > 0 ? (
            <SidebarSection label="Workspace Plugins">
              {shellNavigation.map((item) => (
              <SidebarNavItem
                key={`workspace-shell:${item.id}`}
                to={item.target}
                label={item.displayName}
                icon={Puzzle}
                end
              />
              ))}
              {workspacePluginPages.map((slot) => (
                shellNavigationTargets.has(`/${slot.routePath}`.replace(/\/+$/, "")) ? null :
                <SidebarNavItem
                  key={`${slot.pluginKey}:${slot.id}`}
                  to={`/${selectedCompany!.issuePrefix}/${slot.routePath}`}
                  label={slot.displayName}
                  icon={Puzzle}
                  end
                />
              ))}
            </SidebarSection>
          ) : null}

          {canManageCoreHost ? (
            <SidebarSection label="Core Platform" collapsible={{ open: companyOpen, onOpenChange: setCompanyOpen }}>
              <SidebarNavItem to="/company/settings" label="Host settings" icon={Settings} />
            </SidebarSection>
          ) : null}
        </nav>
      </aside>
    );
  }

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <ProductBrand compact={rail} className="mr-auto" />
        {/* In the collapsed rail the search/toggle controls don't fit beside the
            logo — keeping them would overflow the 64px rail and squeeze the logo
            out of alignment with the icon column below it (PAP-10676). They return
            as soon as the panel is expanded (pinned) or peeking. Expansion in the
            rail is still reachable via hover-peek + Pin and Cmd/Ctrl+B. */}
        {!rail ? (
          <>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground shrink-0"
              aria-label="Open search"
              title="Open search"
            >
              <NavLink to="/search">
                <Search className="h-4 w-4" />
              </NavLink>
            </Button>
            {/* Desktop-only collapse/expand affordance. While peeking (hover flyout
                over the collapsed rail) it becomes a Pin that promotes the peek to a
                pinned-expanded sidebar; otherwise it toggles the pinned rail. Mobile
                uses the off-canvas drawer, so this control is hidden there. It is
                also hidden while a secondary sidebar forces the rail (collapseLocked):
                the user cannot expand the primary while a secondary sidebar is shown. */}
            {!isMobile && !collapseLocked ? (
              peeking ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  aria-label="Keep sidebar expanded"
                  title="Keep sidebar expanded"
                  onClick={() => setCollapsed(false)}
                >
                  <Pin className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  onClick={() => toggleCollapsed()}
                >
                  {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                </Button>
              )
            ) : null}
          </>
        ) : null}
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 pointer-coarse:gap-3 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <SidebarCompanyMenu />
        </div>
        <div className="flex flex-col gap-0.5">
          {/* A Workplane Task is created by a Lead from a Room. The general
              Core shortcut remains available to other deployments, but SPS
              Desktop does not surface a bypass in its primary navigation. */}
          {!spsWorkplaneShell ? (() => {
            const newTaskButton = (
              <button
                onClick={() => openNewIssue()}
                data-slot="icon-button"
                aria-label={rail ? "New Task" : undefined}
                className="flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-foreground/80 hover:bg-accent/50 hover:text-foreground transition-colors"
              >
                <SquarePen className="h-4 w-4 shrink-0" />
                <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>New Task</span>
              </button>
            );
            return rail ? (
              <Tooltip>
                <TooltipTrigger asChild>{newTaskButton}</TooltipTrigger>
                <TooltipContent side="right">New Task</TooltipContent>
              </Tooltip>
            ) : (
              newTaskButton
            );
          })() : null}
          <SidebarNavItem to="/dashboard" label={spsWorkplaneShell ? "홈" : "Dashboard"} icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label={spsWorkplaneShell ? "검토함" : "Inbox"}
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeLabel="unread"
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          {showDecisions ? (
            <SidebarNavItem
              to="/decisions"
              label="Decisions"
              icon={ListChecks}
              badge={attentionCount}
              badgeLabel="decisions"
            />
          ) : null}
          {conferenceRoomChatEnabled ? (
            <SidebarNavItem to="/board-chat" label="Conference Room" icon={MessagesSquare} />
          ) : null}
        </div>

        <SidebarSection label={spsWorkplaneShell ? "작업" : "Work"} collapsible={{ open: workOpen, onOpenChange: setWorkOpen }}>
          {spsWorkplaneShell ? (
            <>
              <SidebarNavItem to="/agent-rooms" label="Rooms" icon={MessagesSquare} />
              <SidebarNavItem to="/projects" label="프로젝트" icon={FolderOpen} />
              <SidebarNavItem to="/issues" label="Tasks" icon={CircleDot} />
            </>
          ) : (
            <>
              <SidebarNavItem to="/issues" label="Tasks" icon={CircleDot} />
              {showCases ? (
                <SidebarNavItem to="/cases" label="Cases" icon={Layers} textBadge="beta" />
              ) : null}
              {!basicMode ? <SidebarNavItem to="/routines" label="Routines" icon={Repeat} /> : null}
              {showPipelines ? (
                <SidebarNavItem to="/pipelines" label="Pipelines" icon={GitBranch} />
              ) : null}
              {showGoalsLink ? (
                <SidebarNavItem to="/goals" label="Goals" icon={Target} />
              ) : goalsLinkPending ? (
                <div
                  data-testid="sidebar-goals-placeholder"
                  className="h-8 pointer-coarse:h-7"
                  aria-hidden="true"
                />
              ) : null}
              {!basicMode ? <SidebarNavItem to="/artifacts" label="Artifacts" icon={Package} /> : null}
              {!basicMode ? <SidebarNavItem to="/skills" label="Skills" icon={Boxes} /> : null}
              {showWorkspacesLink ? (
                <SidebarNavItem to="/workspaces" label="Workspaces" icon={GitBranch} />
              ) : null}
              {streamlined ? (
                <>
                  <SidebarNavItem to="/projects" label="Projects" icon={FolderOpen} />
                  <SidebarStarredProjects />
                </>
              ) : null}
              {!basicMode ? (
                <>
                  <PluginSlotOutlet
                    slotTypes={["sidebar"]}
                    context={pluginContext}
                    className="flex flex-col gap-0.5"
                    itemClassName="text-(length:--text-compact) font-medium"
                    missingBehavior="placeholder"
                  />
                  <PluginLauncherOutlet
                    placementZones={["sidebar"]}
                    context={pluginContext}
                    className="flex flex-col gap-0.5"
                    itemClassName="text-(length:--text-compact) font-medium"
                  />
                </>
              ) : null}
            </>
          )}
        </SidebarSection>

        {/* Classic mode restores the per-project collapsible below Work. */}
        {streamlined ? null : <SidebarProjects />}

        <SidebarAgents streamlined={streamlined} />

        <SidebarSection label={spsWorkplaneShell ? "관리" : basicMode ? "Server" : workplaneMode ? "System" : "Company"} collapsible={{ open: companyOpen, onOpenChange: setCompanyOpen }}>
          {!basicMode && !workplaneMode ? <SidebarNavItem to="/org" label="Org" icon={Network} /> : null}
          {!basicMode ? <SidebarNavItem to="/timeline" label="Timeline" icon={GanttChartSquare} /> : null}
          {!basicMode ? <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} /> : null}
          {!basicMode ? <SidebarNavItem to="/activity" label="Activity" icon={History} /> : null}
          <SidebarNavItem to="/company/settings" label={spsWorkplaneShell ? "서버 설정" : basicMode ? "Server Settings" : "Settings"} icon={Settings} />
        </SidebarSection>

        {!basicMode ? (
          <PluginSlotOutlet
            slotTypes={["sidebarPanel"]}
            context={pluginContext}
            className="flex flex-col gap-3"
            itemClassName="rounded-lg border border-border p-3"
            missingBehavior="placeholder"
          />
        ) : null}
      </nav>
    </aside>
  );
}
