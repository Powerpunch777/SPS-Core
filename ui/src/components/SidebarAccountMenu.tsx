import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  LogOut,
  Megaphone,
  type LucideIcon,
  UserRound,
  UserRoundPen,
} from "lucide-react";
import type { DeploymentMode } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useSidebar } from "../context/SidebarContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import { SidebarServerInfo } from "./SidebarServerInfo";
import { Badge } from "@/components/ui/badge";

const PROFILE_SETTINGS_PATH = "/company/settings/instance/profile";
const DOCS_URL = "https://redongames.com/";
const FEEDBACK_URL = "https://github.com/Powerpunch777/SPS/issues";

interface SidebarAccountMenuProps {
  deploymentMode?: DeploymentMode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  version?: string | null;
}

interface MenuActionProps {
  label: string;
  description: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  external?: boolean;
}

interface SpsDesktopAccount {
  signedIn: boolean;
  name: string | null;
  email: string | null;
  picture: string | null;
}

interface SpsDesktopWorkspaceBridge {
  getDesktopAccount: () => Promise<SpsDesktopAccount>;
  signOutDesktopAccount: () => Promise<unknown>;
}

function getSpsDesktopWorkspaceBridge(): SpsDesktopWorkspaceBridge | undefined {
  return (window as Window & { spsDesktopWorkspace?: SpsDesktopWorkspaceBridge }).spsDesktopWorkspace;
}

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function displaySpsAccountName(name: string | null | undefined) {
  const normalized = name?.trim();
  // `Board` is the upstream local-session seed name, not a person's identity.
  // Keep that storage compatibility while presenting the SPS ownership model.
  return normalized && normalized !== "Board" ? normalized : "Owner";
}

function deriveUserSlug(name: string | null | undefined, email: string | null | undefined, id: string | null | undefined) {
  const candidates = [name, email?.split("@")[0], email, id];
  for (const candidate of candidates) {
    const slug = candidate
      ?.trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  return "me";
}

function MenuAction({ label, description, icon: Icon, onClick, href, external = false }: MenuActionProps) {
  const className =
    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60";

  const content = (
    <>
      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </>
  );

  if (href) {
    if (external) {
      return (
        <a href={href} target="_blank" rel="noreferrer" className={className} onClick={onClick}>
          {content}
        </a>
      );
    }

    return (
      <Link to={href} className={className} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

export function SidebarAccountMenu({
  deploymentMode,
  open: controlledOpen,
  onOpenChange,
  version,
}: SidebarAccountMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const desktopBridge = getSpsDesktopWorkspaceBridge();
  const { data: desktopAccount } = useQuery({
    queryKey: ["sps", "desktop", "account"],
    queryFn: () => desktopBridge!.getDesktopAccount(),
    enabled: Boolean(desktopBridge),
    retry: false,
    staleTime: Infinity,
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });
  const desktopSignOutMutation = useMutation({
    mutationFn: async () => {
      if (!desktopBridge) throw new Error("SPS Desktop account controls are unavailable.");
      await desktopBridge.signOutDesktopAccount();
    },
    onSuccess: () => setOpen(false),
  });

  const desktopSignedIn = desktopAccount?.signedIn === true;
  const displayName = desktopSignedIn
    ? displaySpsAccountName(desktopAccount.name)
    : displaySpsAccountName(session?.user.name);
  const secondaryLabel =
    (desktopSignedIn ? desktopAccount.email?.trim() : session?.user.email?.trim())
    || (deploymentMode === "authenticated" ? "Signed in" : "Local workspace owner");
  const accountBadge = desktopSignedIn ? "Desktop" : deploymentMode === "authenticated" ? "Account" : "Local";
  const initials = deriveInitials(displayName);
  const profileHref = `/u/${deriveUserSlug(session?.user.name, session?.user.email, session?.user.id)}`;
  const profileImage = desktopSignedIn ? desktopAccount.picture : session?.user.image;

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  return (
    <div className="border-t border-border/60 bg-app-surface px-3 py-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-(length:--text-compact) font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
            aria-label="Open account menu"
          >
            <Avatar size="sm">
              {profileImage ? <AvatarImage src={profileImage} alt={displayName} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className={cn("min-w-0 flex-1 truncate", rail && SIDEBAR_RAIL_HIDDEN_LABEL)}>{displayName}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          className="w-(--sz-277px) max-w-(--sz-calc-24) overflow-hidden rounded-t-2xl rounded-b-none border-border p-0 shadow-2xl"
        >
          <div className="h-24 bg-(image:--gradient-extract-25)" />
          <div className="-mt-8 px-4 pb-4">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border-4 border-popover bg-popover p-0.5 shadow-sm">
                <Avatar size="lg">
                  {profileImage ? <AvatarImage src={profileImage} alt={displayName} /> : null}
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              </div>
              <div className="min-w-0 flex-1 pt-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-foreground">{displayName}</h2>
                  <Badge variant="ghost" className="bg-accent text-(length:--text-nano) font-semibold uppercase tracking-wide text-muted-foreground">
                    {accountBadge}
                  </Badge>
                </div>
                <p className="truncate text-sm text-muted-foreground">{secondaryLabel}</p>
                {version ? (
                  <p className="mt-1 text-xs text-muted-foreground">SPS v{version}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-4 space-y-1">
              <MenuAction
                label="View profile"
                description="Open your activity, task, and usage ledger."
                icon={UserRound}
                href={profileHref}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label="Edit profile"
                description="Update your display name and avatar."
                icon={UserRoundPen}
                href={PROFILE_SETTINGS_PATH}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label="SPS Guide"
                description="Open SPS help in a new tab."
                icon={BookOpen}
                href={DOCS_URL}
                external
                onClick={() => setOpen(false)}
              />
              <MenuAction
                label="Report an issue"
                description="Open the SPS issue tracker."
                icon={Megaphone}
                href={FEEDBACK_URL}
                external
                onClick={() => setOpen(false)}
              />
              <ThemeToggle variant="menu-action" onAfterToggle={() => setOpen(false)} />
              {desktopSignedIn ? (
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-destructive/10",
                    desktopSignOutMutation.isPending && "cursor-not-allowed opacity-60",
                  )}
                  onClick={() => desktopSignOutMutation.mutate()}
                  disabled={desktopSignOutMutation.isPending}
                >
                  <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
                    <LogOut className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {desktopSignOutMutation.isPending ? "로그아웃 중..." : "SPS Desktop 로그아웃"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      이 컴퓨터의 Google 계정 연결을 종료합니다.
                    </span>
                  </span>
                </button>
              ) : deploymentMode === "authenticated" ? (
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-destructive/10",
                    signOutMutation.isPending && "cursor-not-allowed opacity-60",
                  )}
                  onClick={() => signOutMutation.mutate()}
                  disabled={signOutMutation.isPending}
                >
                  <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
                    <LogOut className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {signOutMutation.isPending ? "Signing out..." : "Sign out"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      End this browser session.
                    </span>
                  </span>
                </button>
              ) : null}
              <SidebarServerInfo />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
