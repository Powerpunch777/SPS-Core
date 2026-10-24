import { normalizeCompanyPrefix } from "./company-routes";

/**
 * Workspace Shell default routes are always company-relative plugin routes.
 * Prefix them explicitly because the generic router cannot distinguish an
 * unknown plugin route such as `/discover` from an unprefixed company slug.
 */
export function workspaceShellRoute(
  defaultRoute: string | null | undefined,
  companyPrefix: string | null | undefined,
): string {
  const route = safeShellRoute(defaultRoute) ? defaultRoute! : "/dashboard";
  if (!companyPrefix) return route;
  return `/${normalizeCompanyPrefix(companyPrefix)}${route}`;
}

function safeShellRoute(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.length > 500 || !value.startsWith("/") || value.startsWith("//")) return false;
  // A stored legacy selection must not escape its Workspace or loop at its root.
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const pathname = decodeURIComponent(value.split(/[?#]/, 1)[0]!);
    return pathname.length > 1 && !pathname.includes("..") && !/[\\%\u0000-\u001f\u007f]/.test(pathname);
  } catch {
    return false;
  }
}
