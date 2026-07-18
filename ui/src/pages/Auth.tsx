import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { getRememberedInvitePath } from "../lib/invite-memory";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProductBrand } from "@/components/ProductBrand";
import { PRODUCT_NAME } from "@/lib/product-brand";

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const nextPath = useMemo(
    () => safeNextPath(searchParams.get("next") || getRememberedInvitePath()),
    [searchParams],
  );
  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    if (session) navigate(nextPath, { replace: true });
  }, [session, navigate, nextPath]);

  const googleMutation = useMutation({
    mutationFn: () => authApi.signInGoogle({ callbackURL: nextPath }),
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Google sign-in could not start.");
    },
  });

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle />
      </div>
      <main className="flex w-full flex-col overflow-y-auto md:w-1/2">
        <div className="my-auto mx-auto w-full max-w-md px-8 py-12">
          <div className="mb-8">
            <ProductBrand linkToHome={false} />
          </div>
          <h1 className="text-xl font-semibold">Continue to {PRODUCT_NAME}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with the Google account you use for this SPS workspace.
          </p>
          <Button
            type="button"
            className="mt-6 w-full"
            disabled={googleMutation.isPending}
            onClick={() => {
              setError(null);
              googleMutation.mutate();
            }}
          >
            {googleMutation.isPending ? "Opening Google..." : "Continue with Google"}
          </Button>
          {error ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <p className="mt-5 text-xs leading-5 text-muted-foreground">
            Your Google account identifies you to SPS. It does not grant SPS access until you create or accept an
            organization invitation.
          </p>
        </div>
      </main>
      <div className="hidden w-1/2 overflow-hidden md:block">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
