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
  const route = defaultRoute?.startsWith("/") ? defaultRoute : "/dashboard";
  if (!companyPrefix) return route;
  return `/${normalizeCompanyPrefix(companyPrefix)}${route}`;
}
