import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  CircleAlert,
  Inbox,
  Info,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useNavigate } from "@/lib/router";
import {
  workspaceSurfacesApi,
  type SpsWorkspaceInboxItem,
} from "@/api/workspace-surfaces";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type InboxView = "all" | "unread" | "archived";

const severityStyles: Record<SpsWorkspaceInboxItem["severity"], string> = {
  info: "text-blue-600 bg-blue-500/10",
  success: "text-emerald-600 bg-emerald-500/10",
  warning: "text-amber-600 bg-amber-500/10",
  error: "text-destructive bg-destructive/10",
};

function SeverityIcon({ severity }: { severity: SpsWorkspaceInboxItem["severity"] }) {
  const className = "h-4 w-4";
  switch (severity) {
    case "success":
      return <CheckCircle2 className={className} />;
    case "warning":
      return <TriangleAlert className={className} />;
    case "error":
      return <CircleAlert className={className} />;
    case "info":
      return <Info className={className} />;
  }
}

function relativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function SpsWorkspaceInbox() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<InboxView>("all");
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const includeArchived = view === "archived";

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Workspace", href: "/dashboard" },
      { label: "Inbox" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.workspaceSurfaces.inbox(
      selectedCompanyId ?? "",
      includeArchived,
    ),
    queryFn: () => workspaceSurfacesApi.listInbox(selectedCompanyId!, {
      archived: includeArchived,
    }),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 15_000,
  });
  const items = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return (data?.items ?? []).filter((item) => {
      if (view === "unread" && !item.unread) return false;
      if (view === "archived" && !item.archivedAt) return false;
      if (view !== "archived" && item.archivedAt) return false;
      if (!normalizedSearch) return true;
      return [
        item.title,
        item.summary,
        item.category,
        item.sourcePluginDisplayName,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch));
    });
  }, [data?.items, search, view]);

  useEffect(() => {
    setSelectedIndex((current) => Math.max(0, Math.min(current, items.length - 1)));
  }, [items.length]);

  const invalidateInbox = () => queryClient.invalidateQueries({
    queryKey: queryKeys.workspaceSurfaces.inboxPrefix(selectedCompanyId!),
  });
  const stateMutation = useMutation({
    mutationFn: (input: {
      itemId: string;
      state: { read?: boolean; archived?: boolean };
    }) => workspaceSurfacesApi.setInboxState(
      selectedCompanyId!,
      input.itemId,
      input.state,
    ),
    onSuccess: invalidateInbox,
  });
  const actionMutation = useMutation({
    mutationFn: (input: { itemId: string; actionId: string }) =>
      workspaceSurfacesApi.performInboxAction(
        selectedCompanyId!,
        input.itemId,
        input.actionId,
      ),
    onSuccess: invalidateInbox,
  });

  function openItem(item: SpsWorkspaceInboxItem) {
    if (item.unread) {
      stateMutation.mutate({ itemId: item.id, state: { read: true } });
    }
    if (item.navigationTarget) navigate(item.navigationTarget);
  }

  function handleListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (items.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(items.length - 1, current + 1));
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      openItem(items[selectedIndex]!);
    }
  }

  return (
    <main className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col px-1 py-2">
      <header className="shrink-0 border-b border-border pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Inbox className="h-5 w-5 text-muted-foreground" />
              Inbox
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Reports and notifications from active Workspace plugins.
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-8"
              placeholder="Search Inbox"
              aria-label="Search Inbox"
            />
          </div>
        </div>
        <div className="mt-4 flex gap-1" role="tablist" aria-label="Inbox filters">
          {(["all", "unread", "archived"] as const).map((nextView) => (
            <Button
              key={nextView}
              role="tab"
              aria-selected={view === nextView}
              variant={view === nextView ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                setView(nextView);
                setSelectedIndex(0);
              }}
            >
              {nextView === "all" ? "All" : nextView === "unread" ? "Unread" : "Archived"}
            </Button>
          ))}
        </div>
      </header>

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto py-3 outline-none"
        tabIndex={0}
        aria-label="Workspace Inbox items"
        onKeyDown={handleListKeyDown}
      >
        {isLoading ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">Loading Inbox...</p>
        ) : error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
            Failed to load Inbox: {error instanceof Error ? error.message : "Unknown error"}
          </p>
        ) : items.length === 0 ? (
          <div className="px-3 py-16 text-center">
            <Inbox className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">Nothing here</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {search ? "No items match your search." : "Plugin reports will appear here."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border bg-card">
            {items.map((item, index) => (
              <article
                key={item.id}
                className={cn(
                  "group flex gap-3 px-3 py-3 transition-colors",
                  index === selectedIndex && "bg-accent/45",
                  item.unread && "bg-primary/[0.035]",
                )}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 gap-3 text-left outline-none"
                  onClick={() => openItem(item)}
                >
                  <span className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                    severityStyles[item.severity],
                  )}>
                    <SeverityIcon severity={item.severity} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={cn("truncate text-sm", item.unread && "font-semibold")}>
                        {item.title}
                      </span>
                      {item.unread ? (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />
                      ) : null}
                    </span>
                    <span className="mt-0.5 block line-clamp-2 text-sm text-muted-foreground">
                      {item.summary}
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{item.sourcePluginDisplayName}</span>
                      <span aria-hidden="true">/</span>
                      <span>{item.category}</span>
                      <span aria-hidden="true">/</span>
                      <time dateTime={item.updatedAt} title={new Date(item.updatedAt).toLocaleString()}>
                        {relativeTime(item.updatedAt)}
                      </time>
                    </span>
                  </span>
                </button>

                <div className="flex shrink-0 flex-col items-end justify-between gap-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={item.archivedAt ? `Restore ${item.title}` : `Archive ${item.title}`}
                    title={item.archivedAt ? "Restore" : "Archive"}
                    disabled={stateMutation.isPending}
                    onClick={() => stateMutation.mutate({
                      itemId: item.id,
                      state: { archived: !item.archivedAt },
                    })}
                  >
                    {item.archivedAt
                      ? <ArchiveRestore className="h-4 w-4" />
                      : <Archive className="h-4 w-4" />}
                  </Button>
                  {item.actions.length > 0 ? (
                    <div className="flex flex-wrap justify-end gap-1">
                      {item.actions.map((action) => (
                        <Button
                          key={action.id}
                          variant={action.destructive ? "destructive" : "outline"}
                          size="sm"
                          disabled={actionMutation.isPending}
                          onClick={() => actionMutation.mutate({
                            itemId: item.id,
                            actionId: action.id,
                          })}
                        >
                          {action.displayName}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {stateMutation.error || actionMutation.error ? (
        <p className="shrink-0 border-t border-border pt-2 text-sm text-destructive">
          {(stateMutation.error ?? actionMutation.error) instanceof Error
            ? (stateMutation.error ?? actionMutation.error as Error).message
            : "Inbox operation failed."}
        </p>
      ) : null}
    </main>
  );
}
