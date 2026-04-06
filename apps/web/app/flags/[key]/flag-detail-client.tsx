"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type EnvironmentRef = { id: string; name: string; slug: string };

export default function FlagDetailClient({
  flagKey,
  initialFlag,
  initialEnvironments,
  isAdmin,
}: {
  flagKey: string;
  initialFlag: {
    id: string;
    name: string;
    key: string;
    description: string;
    createdAt: string;
    states: Record<string, boolean>;
  };
  initialEnvironments: EnvironmentRef[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [name, setName] = React.useState(initialFlag.name);
  const [description, setDescription] = React.useState(initialFlag.description);
  const [states, setStates] = React.useState(initialFlag.states);
  const [savingMeta, setSavingMeta] = React.useState(false);
  const [toggleBusy, setToggleBusy] = React.useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  React.useEffect(() => {
    setName(initialFlag.name);
    setDescription(initialFlag.description);
    setStates(initialFlag.states);
  }, [initialFlag]);

  async function saveMeta() {
    setSavingMeta(true);
    try {
      const res = await fetch(`/api/flags/${encodeURIComponent(flagKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err.error === "string" ? err.error : "Could not save");
        return;
      }
      toast.success("Changes saved");
      router.refresh();
    } finally {
      setSavingMeta(false);
    }
  }

  async function toggleEnv(environmentId: string) {
    setToggleBusy(environmentId);
    try {
      const res = await fetch(`/api/flags/${encodeURIComponent(flagKey)}/toggle`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environmentId }),
      });
      if (!res.ok) return;
      const { enabled } = (await res.json()) as { enabled: boolean };
      const env = initialEnvironments.find((e) => e.id === environmentId);
      if (env) {
        setStates((s) => ({ ...s, [env.slug]: enabled }));
      }
    } finally {
      setToggleBusy(null);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this flag everywhere? This cannot be undone.")) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/flags/${encodeURIComponent(flagKey)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        router.push("/");
        router.refresh();
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="page-container page-container-narrow flex flex-1 flex-col pb-16">
      <div className="page-enter mb-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          All flags
        </Link>
      </div>

      <header className="page-enter page-enter-delay-1 mb-8">
        <h1 className="page-title">{name}</h1>
        <code className="mt-2 block font-mono text-sm text-muted-foreground">{initialFlag.key}</code>
      </header>

      {isAdmin ? (
        <Card className="surface-card page-enter page-enter-delay-2 mb-8">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="font-heading text-base font-medium">Details</CardTitle>
            <CardDescription>The flag key cannot be changed after creation.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 pt-6">
            <div className="space-y-2">
              <Label htmlFor="detail-name">Name</Label>
              <Input
                id="detail-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="detail-desc">Description</Label>
              <Textarea
                id="detail-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={savingMeta}
                onClick={() => void saveMeta()}
              >
                {savingMeta ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="surface-card page-enter page-enter-delay-2 mb-8 px-6 py-5">
          <p className="text-sm text-muted-foreground">{initialFlag.description || "No description."}</p>
        </div>
      )}

      <section className="page-enter page-enter-delay-3">
        <h2 className="font-heading text-base font-medium text-foreground">Environments</h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">On or off for each environment.</p>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2">
          {initialEnvironments.map((env) => {
            const on = states[env.slug] ?? false;
            const busy = toggleBusy === env.id;
            return (
              <li key={env.id}>
                <Card className="h-full shadow-none">
                  <CardContent className="flex items-center justify-between gap-4 px-5 py-5">
                    <div className="min-w-0">
                      <p className="font-medium">{env.name}</p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">{env.slug}</p>
                    </div>
                    {isAdmin ? (
                      <Switch
                        checked={on}
                        disabled={busy}
                        onCheckedChange={() => void toggleEnv(env.id)}
                        aria-label={`Enable ${initialFlag.name} in ${env.name}`}
                      />
                    ) : (
                      <span className="font-mono text-xs font-medium tabular-nums text-muted-foreground">
                        {on ? "ON" : "OFF"}
                      </span>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      </section>

      {isAdmin ? (
        <div className="page-enter page-enter-delay-4 mt-12 border-t border-border pt-8">
          <h2 className="text-sm font-medium text-destructive">Delete flag</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Removes this flag and its settings in every environment.
          </p>
          <Button
            type="button"
            variant="destructive"
            className="mt-4 gap-2"
            disabled={deleteBusy}
            onClick={() => void handleDelete()}
          >
            <Trash2 className="size-4" aria-hidden />
            Delete flag
          </Button>
        </div>
      ) : null}
    </div>
  );
}
