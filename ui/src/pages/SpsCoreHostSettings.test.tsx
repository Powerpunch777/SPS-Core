// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "workspace-a", name: "Test Workspace" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/components/WorkspaceExecutionControl", () => ({
  WorkspaceExecutionControl: ({ companyId }: { companyId: string }) => <section data-execution-workspace={companyId}>Workspace execution</section>,
}));

import { SpsCoreHostSettings } from "./SpsCoreHostSettings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SpsCoreHostSettings", () => {
  it("makes the Agents directory discoverable alongside existing Host settings", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => root.render(<SpsCoreHostSettings />));

      expect(container.querySelector('a[href="/company/settings/agents"]')?.textContent).toContain("Agents");
      expect(container.querySelector('a[href="/company/settings/sps-server"]')).not.toBeNull();
      expect(container.querySelector('a[href="/company/settings/team"]')).not.toBeNull();
      expect(container.querySelector('a[href="/company/settings/project-sources"]')).not.toBeNull();
      expect(container.querySelector('a[href="/company/settings/nodes"]')).not.toBeNull();
      expect(container.querySelector('a[href="/company/settings/instance/model-connections"]')?.textContent).toContain("Model connections");
      expect(container.querySelector('a[href="/company/settings/secrets"]')?.textContent).toContain("Credentials");
      expect(container.querySelector('a[href="/company/settings/instance/plugins"]')).not.toBeNull();
      expect(container.querySelector('[data-execution-workspace="workspace-a"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
