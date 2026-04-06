import { notFound, redirect } from 'next/navigation';
import { getServerSession } from '@/lib/session';
import { getDashboardFlagByKey } from '@/lib/dashboard-flags';
import FlagDetailClient from './flag-detail-client';

export default async function FlagDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const session = await getServerSession();
  if (!session) {
    redirect('/sign-in');
  }

  const { key } = await params;
  const data = await getDashboardFlagByKey(key);
  if (!data) {
    notFound();
  }

  const initialFlag = {
    ...data.flag,
    createdAt: data.flag.createdAt.toISOString(),
  };

  return (
    <FlagDetailClient
      flagKey={key}
      initialFlag={initialFlag}
      initialEnvironments={data.environments}
      isAdmin={session.user.role === 'admin'}
    />
  );
}
