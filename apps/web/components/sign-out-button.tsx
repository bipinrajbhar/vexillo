'use client';

import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

type SignOutButtonProps = Omit<React.ComponentProps<typeof Button>, 'onClick' | 'type'>

export function SignOutButton({
  variant = 'ghost',
  size = 'sm',
  className,
  ...props
}: SignOutButtonProps) {
  const router = useRouter();

  async function handleSignOut() {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => router.push('/sign-in'),
      },
    });
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={handleSignOut}
      {...props}
    >
      Sign out
    </Button>
  );
}
