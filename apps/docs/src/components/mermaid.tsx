'use client';

import { useEffect, useId, useState } from 'react';

let idCounter = 0;

export function Mermaid({ chart }: { chart: string }) {
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Dynamic import: mermaid pulls in a large parser/renderer bundle that has no business being in
    // the initial page JS for pages that don't use it.
    import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
      const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}-${idCounter++}`;
      mermaid
        .render(id, chart)
        .then(({ svg }) => { if (!cancelled) setSvg(svg); })
        .catch((e: Error) => { if (!cancelled) setError(e.message); });
    });
    return () => { cancelled = true; };
  }, [chart, reactId]);

  if (error) {
    return <pre className="overflow-x-auto rounded-lg border border-fd-destructive/40 bg-fd-secondary p-4 text-sm text-fd-destructive">Mermaid render error: {error}</pre>;
  }
  if (!svg) {
    return <div className="rounded-lg border bg-fd-secondary p-4 text-sm text-fd-muted-foreground">Rendering diagram…</div>;
  }
  return <div className="mermaid-diagram my-4 flex justify-center overflow-x-auto rounded-lg border bg-fd-secondary p-4" dangerouslySetInnerHTML={{ __html: svg }} />;
}
