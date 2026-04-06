'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

export default function MembersClient({
  initialMembers,
  currentUserId,
}: {
  initialMembers: Member[];
  currentUserId: string;
}) {
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [busy, setBusy] = useState<string | null>(null);

  async function handleRoleChange(id: string, newRole: 'admin' | 'viewer') {
    setBusy(id);
    const res = await fetch(`/api/members/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      setMembers((prev) =>
        prev.map((m) => (m.id === id ? { ...m, role: newRole } : m)),
      );
    }
    setBusy(null);
  }

  async function handleRemove(id: string) {
    setBusy(id);
    const res = await fetch(`/api/members/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setMembers((prev) => prev.filter((m) => m.id !== id));
    }
    setBusy(null);
  }

  return (
    <div className="page-container page-container-narrow">
      <header className="page-enter mb-8 md:mb-10">
        <h1 className="page-title">Members</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {members.length} member{members.length !== 1 ? "s" : ""} with access to this workspace.
        </p>
      </header>

      <Card className="surface-card page-enter page-enter-delay-1 gap-0 overflow-hidden py-0 shadow-none">
        <CardContent className="p-0">
          {members.map((member, index) => (
            <div key={member.id}>
              {index > 0 ? <Separator /> : null}
              <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-5 sm:px-6">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{member.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {member.id === currentUserId ? (
                    <span className="rounded-md bg-muted px-2.5 py-1 text-xs capitalize text-muted-foreground">
                      {member.role}
                    </span>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === member.id}
                        onClick={() =>
                          handleRoleChange(member.id, member.role === 'admin' ? 'viewer' : 'admin')
                        }
                      >
                        Make {member.role === 'admin' ? 'viewer' : 'admin'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === member.id}
                        onClick={() => handleRemove(member.id)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
