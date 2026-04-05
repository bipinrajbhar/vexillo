'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

function SignInForm() {
  const searchParams = useSearchParams();

  async function handleSignIn() {
    const next = searchParams.get('next') ?? '/';
    const callbackURL = new URL(next, window.location.origin).toString();
    await authClient.signIn.oauth2({
      providerId: 'okta',
      callbackURL,
    });
  }

  return (
    <Button className="w-full" onClick={handleSignIn}>
      Sign in with Okta
    </Button>
  );
}

export default function SignInPage() {
  return (
    <div className="flex min-h-full items-center justify-center">
      <div className="w-full max-w-sm space-y-6 px-6 py-10">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Sign in to Vexillo</h1>
          <p className="text-sm text-gray-500">Use your organisation&apos;s Okta account</p>
        </div>
        <Suspense>
          <SignInForm />
        </Suspense>
      </div>
    </div>
  );
}
