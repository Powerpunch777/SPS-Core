import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, CheckCircle2, Search, ShieldCheck } from "lucide-react";
import { spsMarketplaceApi } from "@/api/sps-marketplace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function SpsMarketplacePanel({ companyId }: { companyId: string }) {
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);

  const catalog = useQuery({
    queryKey: ["sps-marketplace", companyId, query],
    queryFn: () => spsMarketplaceApi.list(companyId, { query, limit: 50 }),
  });
  const selectedPlugin = useQuery({
    queryKey: ["sps-marketplace", companyId, "detail", selectedPluginId],
    queryFn: () => spsMarketplaceApi.get(companyId, selectedPluginId!),
    enabled: Boolean(selectedPluginId),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setQuery(draftQuery.trim());
    setSelectedPluginId(null);
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold">Marketplace</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Browse verified public metadata. Nothing is installed or activated from this view.
            </p>
          </div>
          <form className="flex gap-2" onSubmit={submit}>
            <Input
              aria-label="Search Marketplace"
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="Search by name, capability, or publisher"
            />
            <Button type="submit" variant="outline" className="gap-2">
              <Search className="h-4 w-4" /> Search
            </Button>
          </form>

          {catalog.isLoading ? <p className="text-sm text-muted-foreground">Loading Marketplace...</p> : null}
          {catalog.error ? (
            <div className="rounded-md border border-destructive/25 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive">
              Marketplace is unavailable: {catalog.error.message}
            </div>
          ) : null}
          {catalog.data && catalog.data.plugins.length === 0 ? (
            <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              No verified plugins matched this search.
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {catalog.data?.plugins.map((plugin) => (
              <button
                key={`${plugin.pluginId}:${plugin.version}`}
                type="button"
                className={`rounded-md border p-4 text-left transition-colors hover:bg-muted/50 ${selectedPluginId === plugin.pluginId ? "border-primary bg-muted/40" : ""}`}
                onClick={() => setSelectedPluginId(plugin.pluginId)}
              >
                <div className="flex items-start justify-between gap-3">
                  <strong className="min-w-0 truncate">{plugin.displayName}</strong>
                  <Badge variant="outline">v{plugin.version}</Badge>
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{plugin.summary}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Badge variant="secondary">{plugin.trust}</Badge>
                  {plugin.categories.slice(0, 2).map((category) => <Badge key={category} variant="outline">{category}</Badge>)}
                </div>
              </button>
            ))}
          </div>
          {catalog.data ? (
            <p className="text-xs text-muted-foreground">
              {catalog.data.total} verified plugin{catalog.data.total === 1 ? "" : "s"}
              {catalog.data.refreshedAt ? ` · refreshed ${new Date(catalog.data.refreshedAt).toLocaleString()}` : ""}
            </p>
          ) : null}
        </section>

        <aside className="space-y-3">
          <Card className="py-0">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center gap-2 font-medium"><Bot className="h-4 w-4" /> Marketplace Assistant</div>
              <p className="text-sm text-muted-foreground">
                The Assistant uses your approved AI adapter and can only search or explain Marketplace records.
              </p>
              <div className="space-y-2 text-xs text-muted-foreground">
                <div className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" /> Search verified metadata</div>
                <div className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" /> Explain capabilities and compatibility</div>
                <div className="flex gap-2"><ShieldCheck className="h-4 w-4 shrink-0" /> No install or lifecycle tools</div>
              </div>
            </CardContent>
          </Card>

          {selectedPluginId ? (
            <Card className="py-0">
              <CardContent className="space-y-3 p-4">
                {selectedPlugin.isLoading ? <p className="text-sm text-muted-foreground">Loading details...</p> : null}
                {selectedPlugin.error ? <p className="text-sm text-destructive">Could not load plugin details.</p> : null}
                {selectedPlugin.data ? (
                  <>
                    <div><h3 className="font-semibold">{selectedPlugin.data.plugin.displayName}</h3><p className="text-xs text-muted-foreground">{selectedPlugin.data.plugin.pluginId}</p></div>
                    <p className="text-sm text-muted-foreground">{selectedPlugin.data.plugin.description}</p>
                    <dl className="space-y-2 text-xs">
                      <div><dt className="font-medium">Publisher</dt><dd className="text-muted-foreground">{selectedPlugin.data.plugin.publisher}</dd></div>
                      <div><dt className="font-medium">SPS compatibility</dt><dd className="text-muted-foreground">{selectedPlugin.data.plugin.compatibility.sps ?? "Not declared"}</dd></div>
                      <div><dt className="font-medium">Capabilities</dt><dd className="mt-1 flex flex-wrap gap-1">{selectedPlugin.data.plugin.capabilities.map((capability) => <Badge key={capability} variant="outline">{capability}</Badge>)}</dd></div>
                    </dl>
                    <p className="border-t pt-3 text-xs text-muted-foreground">To install this plugin, use the Host controls in Settings &gt; Plugins.</p>
                  </>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
