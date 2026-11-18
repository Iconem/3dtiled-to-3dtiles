/**
 * Samples — a real dataset for every format the middleware reads, one click into Stream live. A fold at the top of
 * the Library, closed until asked for: one line per format, one button per sample. The source and where it comes from
 * are the button's tooltip; the star next to the dataset bookmarks it once loaded.
 */
import { Button } from '@/components/ui/button';
import type { AppModel } from './App';
import { CATALOG, type Sample } from './catalog';
import { Card } from './components/Card';
import { Advanced } from './components/bits';

export function SamplesCard({ app }: { app: AppModel }) {
  const load = (s: Sample) => { app.loadIntoBuilder({ src: s.src, format: s.format, cache: 'none' }); app.showTab('stream'); };
  return (
    <Card>
      <Advanced id="samples" summary="Samples" hint="public datasets, one click to stream" className="mt-0 border-t-0 pt-0">
        <dl id="sample-list" className="m-0 mt-3 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
          {CATALOG.map((group) => (
            <div key={group.format} className="contents">
              <dt className="text-xs font-medium text-muted-foreground">{group.label}</dt>
              <dd className="m-0 flex flex-wrap gap-1.5">
                {group.samples.map((s) => (
                  <Button key={s.id} size="sm" data-sample={s.id} title={`${s.origin}\n${s.src}`} onClick={() => load(s)}>{s.label}</Button>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="m-0 mt-3 text-xs text-muted-foreground">Hosted by third parties and credited in each tooltip; none is ours unless it says Iconem.</p>
      </Advanced>
    </Card>
  );
}
