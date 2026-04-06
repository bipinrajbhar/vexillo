import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/session';
import { getDashboardFlagsAndEnvironments } from '@/lib/dashboard-flags';
import FlagsPageClient from './flags-page-client';

export default async function Page() {
  const session = await getServerSession();
  if (!session) {
    redirect('/sign-in');
  }

  const { flags, environments } = await getDashboardFlagsAndEnvironments();
  const initialFlags = flags.map((f) => ({
    ...f,
    createdAt: f.createdAt.toISOString(),
  }));

  return (
    <FlagsPageClient
      initialFlags={initialFlags}
      initialEnvironments={environments}
      isAdmin={session.user.role === 'admin'}
    />
  );
}
