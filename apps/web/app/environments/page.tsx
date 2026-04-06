import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/session';
import { getDashboardEnvironmentsList } from '@/lib/dashboard-environments';
import EnvironmentsClient from './environments-client';

export default async function EnvironmentsPage() {
  const session = await getServerSession();
  if (!session) {
    redirect('/sign-in');
  }

  const rows = await getDashboardEnvironmentsList();
  const initialEnvironments = rows.map((e) => ({
    ...e,
    createdAt: e.createdAt.toISOString(),
  }));

  return (
    <EnvironmentsClient
      initialEnvironments={initialEnvironments}
      isAdmin={session.user.role === 'admin'}
    />
  );
}
