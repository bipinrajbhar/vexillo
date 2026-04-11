import { useNavigate } from '@tanstack/react-router'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'

type SignOutButtonProps = Omit<React.ComponentProps<typeof Button>, 'onClick' | 'type'>

export function SignOutButton({
  variant = 'ghost',
  size = 'sm',
  className,
  ...props
}: SignOutButtonProps) {
  const navigate = useNavigate()

  async function handleSignOut() {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => navigate({ to: '/sign-in' }),
      },
    })
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
  )
}
