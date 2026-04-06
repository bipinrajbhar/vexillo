"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function stateLabel(on: boolean) {
  return on ? "On" : "Off";
}

export function ConfirmFlagToggleDialog({
  open,
  onOpenChange,
  flagName,
  flagKey,
  environmentName,
  currentEnabled,
  nextEnabled,
  confirmBusy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flagName: string;
  flagKey: string;
  environmentName: string;
  currentEnabled: boolean;
  nextEnabled: boolean;
  confirmBusy: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton className="gap-4 sm:max-w-sm sm:p-5">
        <DialogHeader className="gap-3 pe-9">
          <DialogTitle className="text-[0.9375rem] font-normal leading-snug text-muted-foreground">
            <span className="font-heading font-medium text-foreground">{flagName}</span>
            <span className="text-muted-foreground"> in {environmentName}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Confirm changing flag {flagName}, key {flagKey}, in {environmentName}, from{" "}
            {stateLabel(currentEnabled)} to {stateLabel(nextEnabled)}.
          </DialogDescription>
          <div className="space-y-3 text-sm text-muted-foreground">
            <code className="block font-mono text-xs text-muted-foreground/90">{flagKey}</code>
            <p className="tabular-nums tracking-tight text-foreground">
              {stateLabel(currentEnabled)}
              <span className="mx-1.5 text-muted-foreground">→</span>
              {stateLabel(nextEnabled)}
            </p>
            <p className="text-[0.8125rem] leading-relaxed">
              Takes effect on the next SDK refresh. Toggle again to revert.
            </p>
          </div>
        </DialogHeader>
        <DialogFooter className="border-0 pt-0 sm:gap-2">
          <DialogClose render={<Button type="button" variant="outline" size="sm" disabled={confirmBusy} />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            size="sm"
            disabled={confirmBusy}
            onClick={() => {
              void Promise.resolve(onConfirm()).catch(() => {});
            }}
          >
            {confirmBusy ? "Saving…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
