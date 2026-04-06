import { Suspense } from "react";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <div className="flex min-h-dvh flex-1 flex-col">
      <div className="absolute end-4 top-4 sm:end-6 sm:top-6">
        <ModeToggle />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-5 py-16 sm:px-8 sm:py-20">
        <div className="w-full max-w-sm">
          <header className="page-enter mb-8 text-center">
            <h1 className="font-heading text-2xl font-normal tracking-[-0.02em] text-foreground sm:text-[1.75rem]">
              Sign in
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">Vexillo — feature flag management</p>
          </header>

          <div className="surface-card page-enter page-enter-delay-1 px-6 py-7">
            <Suspense
              fallback={
                <Button type="button" className="h-10 w-full" disabled aria-busy>
                  Signing in…
                </Button>
              }
            >
              <SignInForm />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
