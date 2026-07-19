import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildSpsInviteUrl, spsCodeToInviteToken } from "@/lib/sps-invite-code";

function defaultHubUrl(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

export function SpsJoinPage() {
  const navigate = useNavigate();
  const [hubUrl, setHubUrl] = useState(defaultHubUrl);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = spsCodeToInviteToken(code);
    if (!token) {
      setError("Enter an SPS code in the form SPS-XXXX-XXXX-XXXX-XXXX.");
      return;
    }

    const inviteUrl = buildSpsInviteUrl(hubUrl, token);
    if (!inviteUrl) {
      setError("Enter a private HTTPS SPS team address. HTTP is allowed only for local development.");
      return;
    }

    const currentOrigin = typeof window === "undefined" ? "" : window.location.origin;
    if (new URL(inviteUrl).origin === currentOrigin) {
      navigate(`/invite/${token}`);
      return;
    }
    window.location.assign(inviteUrl);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-5 py-10">
      <section className="w-full rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-primary text-primary-foreground">
            <KeyRound className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Join SPS</h1>
            <p className="text-sm text-muted-foreground">Use the invitation code shared by your team.</p>
          </div>
        </div>

        <form className="space-y-5" onSubmit={submit}>
          <label className="block space-y-2">
            <span className="text-sm font-medium">SPS team address</span>
            <input
              value={hubUrl}
              onChange={(event) => setHubUrl(event.target.value)}
              placeholder="https://owner-pc.example.ts.net"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
              autoComplete="url"
            />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium">Invitation code</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="SPS-AB12-CD34-EF56-GH78"
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm uppercase tracking-wide outline-none focus:border-ring"
              autoComplete="one-time-code"
              aria-describedby={error ? "sps-join-error" : undefined}
            />
          </label>
          {error ? <p id="sps-join-error" className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" className="w-full">
            Continue to sign in <ArrowRight className="h-4 w-4" />
          </Button>
        </form>

        <p className="mt-5 text-xs leading-5 text-muted-foreground">
          You will sign in or create an SPS account on your team Host before this invitation is accepted.
        </p>
      </section>
    </main>
  );
}
