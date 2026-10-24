import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCircle2, Loader2, Plus, Search, Send, ShieldCheck, X } from "lucide-react";
import { spsMarketplaceApi, type SpsMarketplaceAssistantMessage } from "@/api/sps-marketplace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function newIdempotencyKey() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `sps-assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function AssistantMessage({ message }: { message: SpsMarketplaceAssistantMessage }) {
  if (message.role === "tool") return null;
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-full rounded-lg px-3 py-2 text-sm sm:max-w-xl ${isUser ? "bg-primary text-primary-foreground" : isSystem ? "border border-destructive/25 bg-destructive/[0.06] text-destructive" : "bg-muted"}`}>
        <div className="mb-1 text-micro font-medium opacity-70">{isUser ? "You" : isSystem ? "System" : "Marketplace Assistant"}</div>
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
      </div>
    </div>
  );
}

export function SpsMarketplacePanel({ companyId }: { companyId: string }) {
  return <SpsMarketplacePanelForCompany key={companyId} companyId={companyId} />;
}

function SpsMarketplacePanelForCompany({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState("");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [sessionAction, setSessionAction] = useState<"open" | "send" | "close" | null>(null);
  const sessionActionRef = useRef<"open" | "send" | "close" | null>(null);
  const isMountedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  function beginSessionAction(action: "open" | "send" | "close") {
    if (sessionActionRef.current !== null) return false;
    sessionActionRef.current = action;
    if (isMountedRef.current) setSessionAction(action);
    return true;
  }

  function endSessionAction(action: "open" | "send" | "close") {
    if (sessionActionRef.current !== action) return;
    sessionActionRef.current = null;
    if (isMountedRef.current) setSessionAction(null);
  }

  const catalog = useQuery({
    queryKey: ["sps-marketplace", companyId, query],
    queryFn: () => spsMarketplaceApi.list(companyId, { query, limit: 50 }),
  });
  const selectedPlugin = useQuery({
    queryKey: ["sps-marketplace", companyId, "detail", selectedPluginId],
    queryFn: () => spsMarketplaceApi.get(companyId, selectedPluginId!),
    enabled: Boolean(selectedPluginId),
  });
  const agents = useQuery({
    queryKey: ["sps-marketplace-assistant-agents", companyId],
    queryFn: () => spsMarketplaceApi.listAssistantAgents(companyId),
  });
  const messages = useQuery({
    queryKey: ["sps-marketplace-assistant-messages", companyId, sessionId],
    queryFn: () => spsMarketplaceApi.listAssistantMessages(companyId, sessionId!),
    enabled: Boolean(sessionId),
    refetchInterval: pendingRunId ? 1500 : false,
  });

  const visibleMessages = useMemo(
    () => (messages.data?.messages ?? []).filter((message) => message.role !== "tool"),
    [messages.data?.messages],
  );

  useEffect(() => {
    if (!pendingRunId || visibleMessages.some((message) =>
      (message.role === "assistant" || message.role === "system") && message.runId === pendingRunId,
    )) {
      if (pendingRunId) setPendingRunId(null);
    }
  }, [pendingRunId, visibleMessages]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setQuery(draftQuery.trim());
    setSelectedPluginId(null);
  }

  async function openSession() {
    if (!selectedAgentId || !beginSessionAction("open")) return;
    if (isMountedRef.current) setSessionError(null);
    try {
      const result = await spsMarketplaceApi.openAssistantSession(companyId, selectedAgentId);
      if (!isMountedRef.current) return;
      setSessionId(result.session.id);
      setPendingRunId(null);
    } catch (error) {
      if (isMountedRef.current) {
        setSessionError(error instanceof Error ? error.message : "Could not open the Assistant session.");
      }
    } finally {
      endSessionAction("open");
    }
  }

  async function closeAndReset() {
    if (!beginSessionAction("close")) return;
    try {
      try {
        if (sessionId) {
          await spsMarketplaceApi.closeAssistantSession(companyId, sessionId);
        }
      } catch (error) {
        if (isMountedRef.current) {
          setSessionError(error instanceof Error ? error.message : "Could not close the Assistant session.");
        }
        return;
      }
      if (!isMountedRef.current) return;
      setSessionId(null);
      setDraftMessage("");
      setPendingRunId(null);
      setSessionError(null);
      await queryClient.invalidateQueries({ queryKey: ["sps-marketplace-assistant-agents", companyId] });
    } finally {
      endSessionAction("close");
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = draftMessage.trim();
    if (!sessionId || !content || pendingRunId || !beginSessionAction("send")) return;
    setSessionError(null);
    try {
      const result = await spsMarketplaceApi.sendAssistantMessage(companyId, sessionId, content, newIdempotencyKey());
      if (!isMountedRef.current) return;
      setDraftMessage("");
      setPendingRunId(result.run.id);
      await queryClient.invalidateQueries({ queryKey: ["sps-marketplace-assistant-messages", companyId, sessionId] });
    } catch (error) {
      if (isMountedRef.current) {
        setSessionError(error instanceof Error ? error.message : "Could not send the message.");
      }
    } finally {
      endSessionAction("send");
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-3">
        <section className="min-w-0 space-y-4 xl:col-span-2">
          <div>
            <h2 className="text-base font-semibold">Marketplace</h2>
            <p className="mt-1 text-sm text-muted-foreground">Browse verified public metadata. Nothing is installed or activated from this view.</p>
          </div>
          <form className="flex gap-2" onSubmit={submitSearch}>
            <Input aria-label="Search Marketplace" value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} placeholder="Search by name, capability, or publisher" />
            <Button type="submit" variant="outline" className="shrink-0 gap-2"><Search className="h-4 w-4" /> Search</Button>
          </form>
          {catalog.isLoading ? <p className="text-sm text-muted-foreground">Loading Marketplace...</p> : null}
          {catalog.error ? <div className="rounded-md border border-destructive/25 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive">Marketplace is unavailable: {catalog.error.message}</div> : null}
          {catalog.data && catalog.data.plugins.length === 0 ? <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">No verified plugins matched this search.</div> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {catalog.data?.plugins.map((plugin) => (
              <button key={`${plugin.pluginId}:${plugin.version}`} type="button" className={`rounded-md border p-4 text-left transition-colors hover:bg-muted/50 ${selectedPluginId === plugin.pluginId ? "border-primary bg-muted/40" : ""}`} onClick={() => setSelectedPluginId(plugin.pluginId)}>
                <div className="flex items-start justify-between gap-3"><strong className="min-w-0 truncate">{plugin.displayName}</strong><Badge variant="outline">v{plugin.version}</Badge></div>
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{plugin.summary}</p>
                <div className="mt-3 flex flex-wrap gap-1.5"><Badge variant="secondary">{plugin.trust}</Badge>{plugin.categories.slice(0, 2).map((category) => <Badge key={category} variant="outline">{category}</Badge>)}</div>
              </button>
            ))}
          </div>
          {catalog.data ? <p className="text-xs text-muted-foreground">{catalog.data.total} verified plugin{catalog.data.total === 1 ? "" : "s"}{catalog.data.refreshedAt ? ` · refreshed ${new Date(catalog.data.refreshedAt).toLocaleString()}` : ""}</p> : null}
        </section>

        <aside className="min-w-0 rounded-lg border bg-background">
          <div className="flex items-start justify-between gap-3 border-b p-4">
            <div><div className="flex items-center gap-2 font-medium"><Bot className="h-4 w-4" /> Marketplace Assistant</div><p className="mt-1 text-xs text-muted-foreground">Ask about verified Marketplace metadata using an approved Agent.</p></div>
            {sessionId ? <Button type="button" variant="ghost" size="icon" aria-label="New conversation" title="New conversation" onClick={closeAndReset} disabled={sessionAction !== null}><Plus className="h-4 w-4" /></Button> : null}
          </div>
          <div className="space-y-4 p-4">
            <div className="space-y-2">
              <label className="text-xs font-medium" htmlFor="marketplace-assistant-agent">Assistant Agent</label>
              {agents.isLoading ? <p className="text-sm text-muted-foreground">Loading available Agents...</p> : null}
              {agents.error ? <p className="text-sm text-destructive">Could not load available Agents.</p> : null}
              {!agents.isLoading && !agents.error && agents.data?.agents.length === 0 ? <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">No Agent is available for Marketplace Assistant.</div> : null}
              {agents.data && agents.data.agents.length > 0 ? (
                <div className="flex gap-2">
                  <select id="marketplace-assistant-agent" aria-label="Assistant Agent" value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)} disabled={Boolean(sessionId)} className="h-9 min-w-0 flex-1 rounded-md border bg-transparent px-3 text-sm">
                    <option value="">Choose an Agent</option>
                    {agents.data.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.title ? ` · ${agent.title}` : ""}</option>)}
                  </select>
                  {!sessionId ? <Button type="button" onClick={openSession} disabled={!selectedAgentId || agents.isLoading || sessionAction !== null}>Open</Button> : null}
                </div>
              ) : null}
            </div>
            {sessionError ? <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/[0.06] p-3 text-sm text-destructive"><X className="mt-0.5 h-4 w-4 shrink-0" />{sessionError}</div> : null}
            {sessionId ? (
              <>
                <div className="flex items-center justify-between text-xs text-muted-foreground"><span>Conversation</span>{pendingRunId ? <span className="flex items-center gap-1.5 text-primary"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Working</span> : sessionAction === "send" ? <span>Sending...</span> : <span>Ready</span>}</div>
                <div aria-label="Assistant transcript" className="flex min-h-64 max-h-96 flex-col gap-3 overflow-y-auto rounded-md border p-3">
                  {messages.isLoading ? <p className="text-sm text-muted-foreground">Loading conversation...</p> : null}
                  {!messages.isLoading && visibleMessages.length === 0 ? <p className="m-auto max-w-60 text-center text-sm text-muted-foreground">Ask which verified plugins fit your project or explain a plugin capability.</p> : null}
                  {visibleMessages.map((message) => <AssistantMessage key={message.id} message={message} />)}
                </div>
                <form className="space-y-2" onSubmit={sendMessage}>
                  <Textarea aria-label="Assistant message" value={draftMessage} onChange={(event) => setDraftMessage(event.target.value)} placeholder="Ask about Marketplace plugins..." disabled={Boolean(pendingRunId) || sessionAction !== null} rows={3} />
                  <Button type="submit" className="w-full gap-2" disabled={!draftMessage.trim() || Boolean(pendingRunId) || sessionAction !== null}><Send className="h-4 w-4" /> Send</Button>
                </form>
                <Button type="button" variant="outline" className="w-full" onClick={closeAndReset} disabled={sessionAction !== null}>New conversation</Button>
              </>
            ) : (
              <div className="space-y-3 rounded-md bg-muted/30 p-3 text-sm text-muted-foreground">
                <p>Select an allowed Agent to start a persistent conversation.</p>
                <div className="space-y-2 text-xs"><div className="flex gap-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" /> Search and explain verified metadata</div><div className="flex gap-2"><ShieldCheck className="h-4 w-4 shrink-0" /> Read-only Marketplace access</div></div>
              </div>
            )}
            <p className="border-t pt-3 text-xs text-muted-foreground">Plugin lifecycle actions remain manual Host controls in Settings &gt; Plugins.</p>
          </div>
        </aside>

        {selectedPluginId ? <Card className="py-0 xl:col-start-1 xl:col-span-2"><CardContent className="space-y-3 p-4">{selectedPlugin.isLoading ? <p className="text-sm text-muted-foreground">Loading details...</p> : null}{selectedPlugin.error ? <p className="text-sm text-destructive">Could not load plugin details.</p> : null}{selectedPlugin.data ? <><div><h3 className="font-semibold">{selectedPlugin.data.plugin.displayName}</h3><p className="text-xs text-muted-foreground">{selectedPlugin.data.plugin.pluginId}</p></div><p className="text-sm text-muted-foreground">{selectedPlugin.data.plugin.description}</p><dl className="space-y-2 text-xs"><div><dt className="font-medium">Publisher</dt><dd className="text-muted-foreground">{selectedPlugin.data.plugin.publisher}</dd></div><div><dt className="font-medium">SPS compatibility</dt><dd className="text-muted-foreground">{selectedPlugin.data.plugin.compatibility.sps ?? "Not declared"}</dd></div><div><dt className="font-medium">Capabilities</dt><dd className="mt-1 flex flex-wrap gap-1">{selectedPlugin.data.plugin.capabilities.map((capability) => <Badge key={capability} variant="outline">{capability}</Badge>)}</dd></div></dl></> : null}</CardContent></Card> : null}
      </div>
    </div>
  );
}
