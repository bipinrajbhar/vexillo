"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info, Plus, Search } from "lucide-react";
import { toast } from "sonner";

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
import { cn } from "@/lib/utils";

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
  const tableScrollRef = React.useRef<HTMLDivElement>(null);
  /** Drop-shadow on sticky column only while scrolled — signals overlap, not default chrome. */
  const [stickyEdgeShadow, setStickyEdgeShadow] = React.useState(false);

  const syncStickyEdgeShadow = React.useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    setStickyEdgeShadow(el.scrollLeft > 1);
  }, []);

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

  React.useLayoutEffect(() => {
    syncStickyEdgeShadow();
  }, [syncStickyEdgeShadow, filtered.length, initialEnvironments.length]);

  React.useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => syncStickyEdgeShadow());
    ro.observe(el);
    el.addEventListener("scroll", syncStickyEdgeShadow, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", syncStickyEdgeShadow);
    };
  }, [syncStickyEdgeShadow]);

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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err.error === "string" ? err.error : "Could not update flag");
        return;
      }
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
        query.trim() ? (
          <Alert className="page-enter page-enter-delay-2 max-w-lg [&>svg]:text-muted-foreground">
            <Info aria-hidden />
            <AlertTitle>No matches</AlertTitle>
            <AlertDescription>Try another search term.</AlertDescription>
          </Alert>
        ) : (
          <Alert className="page-enter page-enter-delay-2 max-w-lg [&>svg]:text-muted-foreground">
            <Info aria-hidden />
            <AlertTitle>No flags yet</AlertTitle>
            <AlertDescription className="mt-2 block space-y-4">
              <span className="block">Create a flag to see it here.</span>
              {isAdmin ? (
                <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
                  New flag
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        )
      ) : (
        <div className="table-shell page-enter page-enter-delay-2">
          <Table ref={tableScrollRef} className="data-table">
            <TableHeader>
              <TableRow className="data-table-head-row">
                <TableHead
                  className={cn(
                    "data-table-th data-table-sticky-flag sticky left-0 z-30 min-w-[200px] border-r border-border ps-5 transition-shadow duration-200 ease-out",
                    stickyEdgeShadow && "shadow-[var(--surface-shadow-sticky)]",
                  )}
                >
                  Flag
                </TableHead>
                {initialEnvironments.map((env) => (
                  <TableHead
                    key={env.id}
                    className="data-table-th text-center whitespace-normal"
                    title={env.name}
                  >
                    <span className="inline-block max-w-[7rem] leading-tight">{env.name}</span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((flag) => {
                const enabledCount = initialEnvironments.filter(
                  (e) => flag.states[e.slug],
                ).length;
                const envTotal = initialEnvironments.length;
                const rollout =
                  envTotal === 0
                    ? "muted"
                    : enabledCount === 0
                      ? "off"
                      : enabledCount === envTotal
                        ? "full"
                        : "partial";
                const rowBorder =
                  rollout === "full"
                    ? "border-l-2 border-l-foreground/20 dark:border-l-foreground/35"
                    : rollout === "partial"
                      ? "border-l-2 border-l-amber-600/50 dark:border-l-amber-400/45"
                      : "border-l-2 border-l-border";

                return (
                  <TableRow key={flag.key} className={cn("group/flag data-table-body-row", rowBorder)}>
                    <TableCell
                      className={cn(
                        "data-table-sticky-flag sticky left-0 z-20 border-r border-border py-3 align-top transition-[box-shadow,background-color] duration-200 ease-out group-hover/flag:bg-muted ps-5",
                        stickyEdgeShadow && "shadow-[var(--surface-shadow-sticky)]",
                      )}
                    >
                      <Link
                        href={`/flags/${encodeURIComponent(flag.key)}`}
                        className="group/link block py-1"
                        title={
                          flag.description.trim()
                            ? `${flag.name} — ${flag.description.trim()}`
                            : undefined
                        }
                      >
                        <span className="data-table-primary-label group-hover/link:text-primary">
                          {flag.name}
                        </span>
                        <code className="data-table-mono-meta truncate">{flag.key}</code>
                        {flag.description.trim() ? (
                          <p className="mt-1.5 max-w-[20rem] line-clamp-2 text-[0.8125rem] leading-snug text-muted-foreground">
                            {flag.description.trim()}
                          </p>
                        ) : null}
                        {envTotal > 0 ? (
                          <p
                            className="mt-2 text-[0.6875rem] tabular-nums tracking-wide text-muted-foreground"
                            title={`Enabled in ${enabledCount} of ${envTotal} environments`}
                          >
                            <span
                              className={
                                rollout === "full"
                                  ? "font-medium text-foreground"
                                  : rollout === "partial"
                                    ? "font-medium text-amber-800 dark:text-amber-400"
                                    : undefined
                              }
                            >
                              {enabledCount}/{envTotal}
                            </span>{" "}
                            <span className="text-muted-foreground">environments on</span>
                          </p>
                        ) : null}
                      </Link>
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
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
