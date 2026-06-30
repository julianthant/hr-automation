import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ShortcutList } from "@/components/shared/ShortcutList";
import { KEYBOARD_SHORTCUTS } from "../../../domain/settings/reference.js";

export function ShortcutsGuide({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px] p-0">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <ShortcutList shortcuts={KEYBOARD_SHORTCUTS} className="px-5 py-4" />
      </DialogContent>
    </Dialog>
  );
}
