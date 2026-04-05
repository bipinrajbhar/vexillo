'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

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
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Members</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {members.length} member{members.length !== 1 ? 's' : ''}
        </p>
      </div>

      <div className="rounded-md border divide-y">
        {members.map((member) => (
          <div key={member.id} className="flex items-center justify-between px-4 py-4 gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{member.name}</p>
              <p className="text-xs text-muted-foreground truncate">{member.email}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {member.id === currentUserId ? (
                <span className="text-xs text-muted-foreground capitalize px-3 py-1">{member.role}</span>
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
        ))}
      </div>
    </div>
  );
}
