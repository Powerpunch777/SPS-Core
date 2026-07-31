import { useEffect, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type PluginUninstallOptions = {
  deleteInboxSummaries: boolean;
};

export function PluginUninstallDialog({
  open,
  pluginName,
  pending = false,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  pluginName: string;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (options: PluginUninstallOptions) => void;
}) {
  const [deleteInboxSummaries, setDeleteInboxSummaries] = useState(false);

  useEffect(() => {
    if (open) setDeleteInboxSummaries(false);
  }, [open, pluginName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Uninstall Plugin</DialogTitle>
          <DialogDescription>
            Remove <strong>{pluginName}</strong> from this SPS Host. Inbox summaries are kept by default so past work remains visible.
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3 text-sm">
          <Checkbox
            checked={deleteInboxSummaries}
            onCheckedChange={(checked) => setDeleteInboxSummaries(checked === true)}
            disabled={pending}
            aria-label="Delete Inbox summaries"
          />
          <span className="space-y-1">
            <span className="block font-medium">Delete Inbox summaries</span>
            <span className="block text-muted-foreground">
              Remove all Inbox summaries created by this plugin for every Workspace. Leave unchecked to keep them.
            </span>
          </span>
        </label>
        {!deleteInboxSummaries ? (
          <p className="text-sm text-muted-foreground">Keep Inbox summaries (default)</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => onConfirm({ deleteInboxSummaries })}
          >
            {pending ? "Uninstalling..." : deleteInboxSummaries ? "Uninstall and delete summaries" : "Uninstall and keep summaries"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
