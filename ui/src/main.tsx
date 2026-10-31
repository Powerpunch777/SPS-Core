import * as React from "react";
import * as ReactDOM from "react-dom";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SpsNativeWorkspaceEntry } from "./pages/SpsNativeWorkspaceEntry";
import { SpsNativePluginEntry } from "./pages/SpsNativePluginEntry";
import "@mdxeditor/editor/style.css";
import "./index.css";

const root = createRoot(document.getElementById("root")!);
const nativePluginBridge = window.spsNativePlugin;
const nativeWorkspaceBridge = window.spsNativeWorkspace;

if (nativePluginBridge) {
  root.render(
      <ThemeProvider>
        <TooltipProvider>
          <SpsNativePluginEntry bridge={nativePluginBridge} />
        </TooltipProvider>
      </ThemeProvider>,
  );
} else if (nativeWorkspaceBridge) {
  root.render(
    <StrictMode>
      <ThemeProvider>
        <TooltipProvider>
          <SpsNativeWorkspaceEntry bridge={nativeWorkspaceBridge} />
        </TooltipProvider>
      </ThemeProvider>
    </StrictMode>,
  );
} else {
  void import("./App").then(async ({ App }) => {
    const [router, company, updates, breadcrumbs, panels, sidebar, dialogs, editor, toast, bridge, launchers, query] = await Promise.all([
      import("@/lib/router"),
      import("./context/CompanyContext"),
      import("./context/LiveUpdatesProvider"),
      import("./context/BreadcrumbContext"),
      import("./context/PanelContext"),
      import("./context/SidebarContext"),
      import("./context/DialogContext"),
      import("./context/EditorAutocompleteContext"),
      import("./context/ToastContext"),
      import("./plugins/bridge-init"),
      import("./plugins/launchers"),
      import("@tanstack/react-query"),
    ]);
    bridge.initPluginBridge(React, ReactDOM);
    if ("serviceWorker" in navigator) {
      const registerServiceWorker = () => { void navigator.serviceWorker.register("/sw.js"); };
      if (document.readyState === "complete") registerServiceWorker();
      else window.addEventListener("load", registerServiceWorker, { once: true });
    }
    const queryClient = new query.QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true } } });
    function CompanyAwareBreadcrumbProvider({ children }: { children: React.ReactNode }) {
      const { selectedCompany } = company.useCompany();
      return <breadcrumbs.BreadcrumbProvider companyName={selectedCompany?.name ?? null}>{children}</breadcrumbs.BreadcrumbProvider>;
    }
    root.render(
      <StrictMode>
        <query.QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <router.BrowserRouter>
              <company.CompanyProvider>
                <editor.EditorAutocompleteProvider>
                  <toast.ToastProvider>
                    <updates.LiveUpdatesProvider>
                      <TooltipProvider>
                        <CompanyAwareBreadcrumbProvider>
                          <sidebar.SidebarProvider>
                            <panels.PanelProvider>
                              <launchers.PluginLauncherProvider>
                                <dialogs.DialogProvider><App /></dialogs.DialogProvider>
                              </launchers.PluginLauncherProvider>
                            </panels.PanelProvider>
                          </sidebar.SidebarProvider>
                        </CompanyAwareBreadcrumbProvider>
                      </TooltipProvider>
                    </updates.LiveUpdatesProvider>
                  </toast.ToastProvider>
                </editor.EditorAutocompleteProvider>
              </company.CompanyProvider>
            </router.BrowserRouter>
          </ThemeProvider>
        </query.QueryClientProvider>
      </StrictMode>,
    );
  }).catch(() => {
    root.render(<main role="alert">The SPS workspace could not be loaded. Restart the window and try again.</main>);
  });
}
