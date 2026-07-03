import { useViewerStore } from '@/state/store';

export default function StatusPanel() {
  const statusLine = useViewerStore((s) => s.statusLine);
  const timingLog = useViewerStore((s) => s.timingLog);

  return (
    <div className="pointer-events-none absolute bottom-2 left-2 max-w-md rounded-md bg-black/70 p-2 font-mono text-xs text-white/90">
      <div className="whitespace-pre-wrap">{statusLine}</div>
      {timingLog.length > 0 && (
        <div className="mt-1 border-t border-white/20 pt-1 text-[10px] text-white/70">
          {timingLog.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  );
}
