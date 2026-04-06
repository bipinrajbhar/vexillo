"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info, Plus, Search } from "lucide-react";

import CreateFlagForm from "@/app/components/create-flag-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type EnvironmentRef = { id: string; name: string; slug: string };

export type FlagsPageFlag = {
  id: string;
  name: string;
  key: string;
  description: string;
  createdAt: string;
  states: Record<string, boolean>;
};

export default function FlagsPageClient({
  initialFlags,
  initialEnvironments,
  isAdmin,
}: {
  initialFlags: FlagsPageFlag[];
  initialEnvironments: EnvironmentRef[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [flags, setFlags] = React.useState(initialFlags);
  const [query, setQuery] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [toggleBusy, setToggleBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    setFlags(initialFlags);
  }, [initialFlags]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flags;
    return flags.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.key.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q),
    );
  }, [flags, query]);

  async function handleCreate(data: {
    name: string;
    key: string;
    description: string;
  }) {
    const res = await fetch("/api/flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.error === "string" ? err.error : "Failed to create flag");
    }
    setCreateOpen(false);
    router.refresh();
  }

  async function toggleFlag(flagKey: string, environmentId: string) {
    const busyKey = `${flagKey}:${environmentId}`;
    setToggleBusy(busyKey);
    try {
      const res = await fetch(`/api/flags/${encodeURIComponent(flagKey)}/toggle`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environmentId }),
      });
      if (!res.ok) return;
      const { enabled } = (await res.json()) as { enabled: boolean };
      setFlags((prev) =>
        prev.map((f) => {
          if (f.key !== flagKey) return f;
          const env = initialEnvironments.find((e) => e.id === environmentId);
          if (!env) return f;
          return {
            ...f,
            states: { ...f.states, [env.slug]: enabled },
          };
        }),
      );
    } finally {
      setToggleBusy(null);
    }
  }

  return (
    <div className="page-container page-container-wide flex flex-1 flex-col">
      <header className="page-enter mb-8 md:mb-10">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-lg">
            <h1 className="page-title">Feature flags</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Toggle flags per environment. Changes apply on the next SDK fetch.
            </p>
          </div>
          {isAdmin ? (
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger render={<Button className="shrink-0 gap-2" />}>
                <Plus className="size-4" />
                New flag
              </DialogTrigger>
              <DialogContent
                className="max-h-[min(90dvh,720px)] overflow-y-auto sm:max-w-lg"
                showCloseButton
              >
                <DialogHeader>
                  <DialogTitle>New flag</DialogTitle>
                  <DialogDescription>
                    Add a flag and enable it per environment after creation.
                  </DialogDescription>
                </DialogHeader>
                <CreateFlagForm
                  onSubmit={handleCreate}
                  onCancel={() => setCreateOpen(false)}
                />
              </DialogContent>
            </Dialog>
          ) : null}
        </div>
      </header>

      <div className="page-enter page-enter-delay-1 mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative max-w-md flex-1">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search flags…"
            className="h-9 ps-10"
            aria-label="Search flags"
          />
        </div>
        <p className="text-sm tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{filtered.length}</span>
          {filtered.length === 1 ? " flag" : " flags"}
        </p>
      </div>

      {initialEnvironments.length === 0 ? (
        <Alert className="page-enter page-enter-delay-2 max-w-lg [&>svg]:text-muted-foreground">
          <Info aria-hidden />
          <AlertTitle>No environments yet</AlertTitle>
          <AlertDescription className="mt-2 block space-y-4">
            <span className="block">Create an environment to enable columns here.</span>
            {isAdmin ? (
              <Button className="w-full sm:w-auto" onClick={() => router.push("/environments")}>
                Go to environments
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : filtered.length === 0 ? (
        <Alert className="page-enter page-enter-delay-2 max-w-lg [&>svg]:text-muted-foreground">
          <Info aria-hidden />
          <AlertTitle>No matches</AlertTitle>
          <AlertDescription>Try another search term.</AlertDescription>
        </Alert>
      ) : (
        <div className="surface-card page-enter page-enter-delay-2 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[200px] ps-5 font-medium text-foreground">
                  Flag
                </TableHead>
                <TableHead className="hidden min-w-[180px] font-medium text-foreground md:table-cell">
                  Description
                </TableHead>
                {initialEnvironments.map((env) => (
                  <TableHead
                    key={env.id}
                    className="text-center font-medium text-foreground whitespace-normal"
                    title={env.name}
                  >
                    <span className="inline-block max-w-[7rem] leading-tight">{env.name}</span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((flag) => (
                <TableRow key={flag.key}>
                  <TableCell className="ps-5 align-top">
                    <Link
                      href={`/flags/${encodeURIComponent(flag.key)}`}
                      className="group block py-1"
                    >
                      <span className="text-[0.9375rem] font-medium text-foreground group-hover:text-primary">
                        {flag.name}
                      </span>
                      <code className="mt-1 block truncate font-mono text-[0.72rem] text-muted-foreground">
                        {flag.key}
                      </code>
                    </Link>
                  </TableCell>
                  <TableCell className="hidden max-w-xs align-top md:table-cell">
                    <span className="line-clamp-2 text-sm text-muted-foreground">
                      {flag.description || "—"}
                    </span>
                  </TableCell>
                  {initialEnvironments.map((env) => {
                    const on = flag.states[env.slug] ?? false;
                    const busy = toggleBusy === `${flag.key}:${env.id}`;
                    return (
                      <TableCell key={env.id} className="text-center align-middle">
                        {isAdmin ? (
                          <div className="flex justify-center">
                            <Switch
                              checked={on}
                              disabled={busy}
                              onCheckedChange={() => toggleFlag(flag.key, env.id)}
                              aria-label={`${flag.name} in ${env.name}`}
                            />
                          </div>
                        ) : (
                          <div className="flex justify-center">
                            <Badge
                              variant={on ? "default" : "secondary"}
                              className="rounded-lg px-2.5 font-mono text-[0.65rem] tracking-wide"
                            >
                              {on ? "ON" : "OFF"}
                            </Badge>
                          </div>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
