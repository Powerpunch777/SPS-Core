import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export interface SpsEmptyWorkspaceProps {
  workspaceName: string;
  pluginsHref?: string;
  status?: "empty" | "unavailable";
  onRetry?: () => void;
  retrying?: boolean;
  selectionUnavailable?: boolean;
}

export function SpsEmptyWorkspace({
  workspaceName,
  pluginsHref,
  status = "empty",
  onRetry,
  retrying = false,
  selectionUnavailable = false,
}: SpsEmptyWorkspaceProps) {
  const unavailable = status === "unavailable";
  const message = unavailable
    ? "Workspace could not be loaded."
    : selectionUnavailable
      ? "The selected plugin is unavailable."
      : "No default plugin selected.";

  return (
    <main
      data-sps-workspace-entry={unavailable ? "unavailable" : "empty"}
      className="min-h-dvh w-full bg-background px-6 py-12 text-foreground"
    >
      <section className="mx-auto flex w-full max-w-2xl flex-col items-start gap-4">
        <h1 className="w-full min-w-0 break-words text-2xl font-semibold">{workspaceName}</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        <div className="flex flex-wrap items-center gap-3">
          {pluginsHref ? (
            <Button asChild size="sm" variant="outline">
              <Link to={pluginsHref}>Manage plugins</Link>
            </Button>
          ) : null}
          {unavailable && onRetry ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={retrying}
              aria-busy={retrying}
            >
              {retrying ? "Retrying..." : "Retry"}
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
