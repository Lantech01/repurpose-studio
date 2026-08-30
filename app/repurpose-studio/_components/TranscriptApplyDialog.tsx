"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function TranscriptApplyDialog({
  open,
  onPreserve,
  onRebuild,
  onApplyLater,
}: {
  open: boolean;
  onPreserve: () => void;
  onRebuild: () => void;
  onApplyLater: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onApplyLater()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Aplicar nova transcrição?</DialogTitle>
          <DialogDescription>
            Preservar os cortes é recomendado. Reconstruir substitui per-scene framing,
            split-ratio overrides, transitions e punches, descarta manual scene markers,
            generated SFX e deleted-scene recovery data.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:flex-col">
          <Button variant="outline" onClick={onApplyLater}>
            Aplicar depois
          </Button>
          <Button variant="outline" onClick={onRebuild}>
            Reconstruir timeline com a transcrição
          </Button>
          <Button onClick={onPreserve}>Preservar cortes e adicionar legendas</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
