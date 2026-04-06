"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export default function FlagDetailClient({
  flagKey,
  initialFlag,
  isAdmin,
}: {
  flagKey: string;
  initialFlag: {
    id: string;
    name: string;
    key: string;
    description: string;
  };
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [name, setName] = React.useState(initialFlag.name);
  const [description, setDescription] = React.useState(initialFlag.description);
  const [savingMeta, setSavingMeta] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  React.useEffect(() => {
    setName(initialFlag.name);
    setDescription(initialFlag.description);
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

      {isAdmin ? (
        <Card className="surface-card page-enter page-enter-delay-1 mb-8">
          <CardContent className="space-y-6 pt-6">
            <div className="space-y-2">
              <Label htmlFor="detail-name">Name</Label>
              <Input
                id="detail-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-auto py-2 font-heading text-[1.625rem] font-normal tracking-[-0.02em] md:text-[1.875rem]"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">Key</Label>
              <code className="block font-mono text-sm text-foreground">{initialFlag.key}</code>
              <p className="text-xs text-muted-foreground">The key cannot be changed.</p>
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
            <Button
              type="button"
              disabled={savingMeta}
              onClick={() => void saveMeta()}
            >
              {savingMeta ? "Saving…" : "Save changes"}
            </Button>

            <div className="border-t border-border pt-6">
              <h2 className="text-sm font-medium text-destructive">Delete flag</h2>
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
          </CardContent>
        </Card>
      ) : (
        <>
          <header className="page-enter page-enter-delay-1 mb-8">
            <h1 className="page-title">{initialFlag.name}</h1>
            <code className="mt-2 block font-mono text-sm text-muted-foreground">{initialFlag.key}</code>
          </header>
          <div className="surface-card page-enter page-enter-delay-2 mb-8 px-6 py-5">
            <p className="text-sm text-muted-foreground">{initialFlag.description || "No description."}</p>
          </div>
        </>
      )}
    </div>
  );
}
