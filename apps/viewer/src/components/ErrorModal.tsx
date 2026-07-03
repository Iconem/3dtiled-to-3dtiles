import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useViewerStore } from '@/state/store';

export default function ErrorModal() {
  const error = useViewerStore((s) => s.error);
  const hideError = useViewerStore((s) => s.hideError);

  return (
    <Dialog open={!!error} onOpenChange={(open) => { if (!open) hideError(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-destructive">Error</DialogTitle>
          <DialogDescription asChild>
            <pre className="whitespace-pre-wrap text-xs">{error}</pre>
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
