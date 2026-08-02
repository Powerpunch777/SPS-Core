import { useCallback, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronsUpDown,
  GripVertical,
  LogOut,
  Plus,
  Settings,
  UserPlus,
} from "lucide-react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Company } from "@paperclipai/shared";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { authApi } from "@/api/auth";
import { accessApi } from "@/api/access";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useCompanyOrder } from "@/hooks/useCompanyOrder";
import { queryKeys } from "@/lib/queryKeys";
import { isSpsCoreBaselineModeEnabled } from "@/lib/sps-core-baseline-mode";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

interface SidebarCompanyMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function WorkspaceIcon({ company }: { company: Company }) {
  return (
    <CompanyPatternIcon
      companyName={company.name}
      logoUrl={company.logoUrl}
      brandColor={company.brandColor}
      className="size-5 shrink-0 rounded-md text-(length:--text-micro)"
    />
  );
}

function SortableCompanyItem({
  company,
  isEditing,
  isSelected,
  showIssuePrefix,
  onSelect,
}: {
  company: Company;
  isEditing: boolean;
  isSelected: boolean;
  showIssuePrefix: boolean;
  onSelect: (company: Company) => void;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: company.id, disabled: !isEditing });

  return (
    <DropdownMenuItem
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      onSelect={(event) => {
        if (isEditing) {
          event.preventDefault();
          return;
        }
        onSelect(company);
      }}
      className={cn(
        "min-w-0 gap-2 py-2",
        isEditing && "cursor-grab",
        isDragging && "opacity-80",
        isSelected && "bg-accent text-accent-foreground",
      )}
    >
      <WorkspaceIcon company={company} />
      <span className="min-w-0 flex-1 truncate">{company.name}</span>
      {isEditing ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Reorder ${company.name}`}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-(length:--rad-2) focus-visible:ring-ring"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      ) : (
        <>
          {showIssuePrefix ? (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground">
              {company.issuePrefix}
            </span>
          ) : null}
          {isSelected ? <Check className="size-4 text-muted-foreground" /> : null}
        </>
      )}
    </DropdownMenuItem>
  );
}

export function SidebarCompanyMenu({ open: controlledOpen, onOpenChange }: SidebarCompanyMenuProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [isEditingOrder, setIsEditingOrder] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const queryClient = useQueryClient();
  const { companies, selectedCompany, setSelectedCompanyId, createCompany } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const location = useLocation();
  const navigate = useNavigate();
  const coreBaselineMode = isSpsCoreBaselineModeEnabled();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 6 },
    }),
  );
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: coreBaselineMode,
    retry: false,
  });
  const canManageCoreHost = !coreBaselineMode || boardAccess?.source === "local_implicit";
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedCompanies, persistOrder } = useCompanyOrder({
    companies: sidebarCompanies,
    userId: currentUserId,
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      if (isMobile) setSidebarOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setIsEditingOrder(false);
    setOpen(nextOpen);
  }

  function closeNavigationChrome() {
    setOpen(false);
    setIsEditingOrder(false);
    if (isMobile) setSidebarOpen(false);
  }

  function selectCompany(company: Company) {
    const pathPrefix = location.pathname.split("/")[1]?.toUpperCase();
    const isCompanyRoute = sidebarCompanies.some((sidebarCompany) => (
      sidebarCompany.issuePrefix.toUpperCase() === pathPrefix
    ));
    const shouldLeaveCurrentRoute = company.id !== selectedCompany?.id
      && (location.pathname.startsWith("/instance/") || isCompanyRoute);

    setSelectedCompanyId(company.id);
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    if (shouldLeaveCurrentRoute) {
      navigate(`/${company.issuePrefix}/dashboard`);
    }
  }

  function addCompany() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    if (coreBaselineMode) {
      setCreateWorkspaceError(null);
      setCreateWorkspaceOpen(true);
      return;
    }
    openOnboarding();
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = workspaceName.trim();
    if (!name || creatingWorkspace) return;

    setCreatingWorkspace(true);
    setCreateWorkspaceError(null);
    try {
      await createCompany({ name });
      setWorkspaceName("");
      setCreateWorkspaceOpen(false);
      navigate("/dashboard");
    } catch (error) {
      setCreateWorkspaceError(error instanceof Error ? error.message : "Workspace could not be created.");
    } finally {
      setCreatingWorkspace(false);
    }
  }

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedCompanies.map((company) => company.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [orderedCompanies, persistOrder],
  );

  return (
    <>
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          // `px-3` (not px-2) so the logo's left edge lines up with the nav icon
          // column (nav px-3 + item px-3) and, crucially, stays put between states:
          // the Button's default size adds `has-[>svg]:px-3`, so with the chevron
          // svg present (expanded) it was already 12px but without it (rail) it fell
          // back to 8px — a 4px horizontal jump on collapse (PAP-10676).
          className="h-9 flex-1 justify-start gap-2 px-3 text-left"
          aria-label={selectedCompany
            ? `Open ${selectedCompany.name} ${coreBaselineMode ? "workspace" : "company"} switcher`
            : `Open ${coreBaselineMode ? "workspace" : "company"} switcher`}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selectedCompany ? <WorkspaceIcon company={selectedCompany} /> : null}
            <span className={cn("truncate text-sm font-bold text-foreground", rail && SIDEBAR_RAIL_HIDDEN_LABEL)}>
              {selectedCompany?.name ?? (coreBaselineMode ? "Select workspace" : "Select company")}
            </span>
          </span>
          {!rail && <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-64 p-1">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <DropdownMenuLabel className="p-0 text-(length:--text-micro) font-semibold uppercase text-muted-foreground">
            {coreBaselineMode ? "Switch workspace" : "Switch company"}
          </DropdownMenuLabel>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsEditingOrder((current) => !current);
            }}
            className="rounded px-1.5 py-0.5 text-(length:--text-micro) font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {isEditingOrder ? "Done" : "Edit"}
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedCompanies.map((company) => company.id)}
              strategy={verticalListSortingStrategy}
            >
              {orderedCompanies.map((company) => (
                <SortableCompanyItem
                  key={company.id}
                  company={company}
                  isEditing={isEditingOrder}
                  isSelected={company.id === selectedCompany?.id}
                  showIssuePrefix={!coreBaselineMode}
                  onSelect={selectCompany}
                />
              ))}
            </SortableContext>
          </DndContext>
          {orderedCompanies.length === 0 ? (
            <DropdownMenuItem disabled>{coreBaselineMode ? "No workspaces" : "No companies"}</DropdownMenuItem>
          ) : null}
        </div>
        {canManageCoreHost ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={addCompany}
              className="gap-2 py-2 text-muted-foreground"
              disabled={isEditingOrder}
            >
              <Plus className="size-4" />
              <span>{coreBaselineMode ? "Create new workspace..." : "Create new company..."}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild disabled={isEditingOrder}>
              <Link
                to={coreBaselineMode ? "/company/settings/team" : "/company/settings/invites"}
                onClick={(event) => {
                  if (isEditingOrder) {
                    event.preventDefault();
                    return;
                  }
                  closeNavigationChrome();
                }}
              >
                <UserPlus className="size-4" />
                <span className="truncate">
                  {coreBaselineMode
                    ? "Team access"
                    : selectedCompany
                      ? `Invite people to ${selectedCompany.name}`
                      : "Invite people"}
                </span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild disabled={isEditingOrder}>
              <Link
                to="/company/settings"
                onClick={(event) => {
                  if (isEditingOrder) {
                    event.preventDefault();
                    return;
                  }
                  closeNavigationChrome();
                }}
              >
                <Settings className="size-4" />
                <span>{coreBaselineMode ? "Host settings" : "Company settings"}</span>
              </Link>
            </DropdownMenuItem>
          </>
        ) : coreBaselineMode && boardAccess ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled className="py-2 text-xs text-muted-foreground">
              Host settings are managed on the Host computer.
            </DropdownMenuItem>
          </>
        ) : null}
        {session?.session ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => signOutMutation.mutate()}
              disabled={isEditingOrder || signOutMutation.isPending}
            >
              <LogOut className="size-4" />
              <span>{signOutMutation.isPending ? "Signing out..." : "Sign out"}</span>
            </DropdownMenuItem>
          </>
        ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {coreBaselineMode ? (
        <Dialog
          open={createWorkspaceOpen}
          onOpenChange={(nextOpen) => {
            if (creatingWorkspace) return;
            setCreateWorkspaceOpen(nextOpen);
            if (!nextOpen) {
              setWorkspaceName("");
              setCreateWorkspaceError(null);
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <form className="grid gap-4" onSubmit={createWorkspace}>
              <DialogHeader>
                <DialogTitle>Create workspace</DialogTitle>
                <DialogDescription>
                  A workspace holds projects, assistants, sources, and plugin configuration.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="new-workspace-name">Workspace name</Label>
                <Input
                  id="new-workspace-name"
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="My workspace"
                  autoFocus
                  maxLength={120}
                  disabled={creatingWorkspace}
                />
                {createWorkspaceError ? (
                  <p role="alert" className="text-sm text-destructive">{createWorkspaceError}</p>
                ) : null}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCreateWorkspaceOpen(false)}
                  disabled={creatingWorkspace}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!workspaceName.trim() || creatingWorkspace}>
                  {creatingWorkspace ? "Creating..." : "Create workspace"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
