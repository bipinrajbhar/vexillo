'use client';

import { useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

export function SignInForm() {
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
    <Button type="button" className="h-10 w-full" onClick={handleSignIn}>
      Continue with Okta
    </Button>
  );
}
