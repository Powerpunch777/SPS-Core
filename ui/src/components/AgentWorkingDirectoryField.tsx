import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { DraftInput } from "./agent-config-primitives";
import { ChoosePathButton } from "./PathInstructionsModal";
import { Button } from "./ui/button";

interface DirectoryBridge {
  chooseAgentWorkingDirectory(): Promise<{ cwd: string } | null>;
}

export function AgentWorkingDirectoryField({ value, onCommit }: { value: string; onCommit(value: string): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  const current = useRef({ value, onCommit });
  current.current = { value, onCommit };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const bridge = (window as Window & { spsDesktopWorkspace?: Partial<DirectoryBridge> }).spsDesktopWorkspace;

  async function choose() {
    if (pending.current || !bridge?.chooseAgentWorkingDirectory) return;
    pending.current = true;
    setBusy(true); setError("");
    const previous = current.current.value;
    try {
      const result = await bridge.chooseAgentWorkingDirectory();
      if (!mounted.current || result === null) return;
      if (current.current.value !== previous) {
        setError("The folder field changed. Choose again to replace it.");
        return;
      }
      if (!result || typeof result.cwd !== "string" || !result.cwd || result.cwd.length > 32_000
        || /[\u0000-\u001f\u007f]/.test(result.cwd)) throw new Error("Invalid folder response");
      current.current.onCommit(result.cwd);
    } catch {
      if (mounted.current) setError("Could not select a folder. Try again or enter its absolute path.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <>
    <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <DraftInput aria-label="Default working folder" value={value} onCommit={onCommit} immediate
        className="w-full bg-transparent text-sm font-mono outline-none placeholder:text-muted-foreground/40" placeholder="C:\\Projects\\my-project" />
      {bridge?.chooseAgentWorkingDirectory
        ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={choose}>{busy ? "Choosing..." : "Choose folder"}</Button>
        : <ChoosePathButton />}
    </div>
    {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
  </>;
}
