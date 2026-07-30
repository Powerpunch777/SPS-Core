import { useEffect } from "react";
import { FolderCog, Network, Puzzle, ServerCog, UsersRound } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const settings = [
  {
    to: "/company/settings/sps-server",
    title: "SPS Server",
    description: "Manage this Host's local server, private team access, and runtime packs.",
    icon: ServerCog,
  },
  {
    to: "/company/settings/team",
    title: "Team access",
    description: "Create member invitations and manage unused technical access links.",
    icon: UsersRound,
  },
  {
    to: "/company/settings/project-sources",
    title: "Sources",
    description: "Choose the Host folders that plugins may use in this Workspace.",
    icon: FolderCog,
  },
  {
    to: "/company/settings/nodes",
    title: "Nodes",
    description: "Review the computers that have joined this Workspace and their safe runtime metadata.",
    icon: Network,
  },
  {
    to: "/company/settings/instance/plugins",
    title: "Plugins",
    description: "Inspect, enable, disable, update, or remove Workspace plugins explicitly.",
    icon: Puzzle,
  },
];

export function SpsCoreHostSettings() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Workspace", href: "/dashboard" },
      { label: "Host settings" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-1 py-2">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ServerCog className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Host settings</h1>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Technical settings for this Host and Workspace. Workflow roles, tasks, approvals, and memory belong to plugins.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {settings.map((setting) => {
          const Icon = setting.icon;
          return (
            <Link key={setting.to} to={setting.to} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Card className="h-full py-0 transition-colors hover:bg-accent/30">
                <CardHeader className="gap-2">
                  <Icon className="h-5 w-5 text-muted-foreground" />
                  <CardTitle className="text-base">{setting.title}</CardTitle>
                  <CardDescription>{setting.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
