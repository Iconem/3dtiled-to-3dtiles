import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronDown } from 'lucide-react';
import { useUrlState } from '@/state/urlState';
import { useViewerStore } from '@/state/store';
import { SNIPPETS } from '@/lib/formats';

export default function SnippetSection() {
  const [url] = useUrlState();
  const currentType = useViewerStore((s) => s.currentType);
  const snip = SNIPPETS[currentType] || SNIPPETS.pointcloud;
  void url;

  return (
    <Card>
      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4 text-xs font-semibold tracking-wide uppercase text-muted-foreground">
          {snip.title} <ChevronDown className="size-4" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{snip.code}</pre>
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{snip.note}</p>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
