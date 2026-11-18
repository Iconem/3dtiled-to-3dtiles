/**
 * Samples — a real dataset for every format the middleware reads, one click into Stream live. A section at the top of
 * the Library that is folded until asked for: one line per format, one button per sample. The source and where it
 * comes from are the button's tooltip; the star next to the dataset bookmarks it once loaded.
 */
import { Button } from '@/components/ui/button';
import type { AppModel } from './App';
import { CATALOG, type Sample } from './catalog';
import { FoldCard, Tip } from './components/bits';

export function SamplesCard({ app }: { app: AppModel }) {
  const load = (s: Sample) => { app.loadIntoBuilder({ src: s.src, format: s.format, cache: 'none' }); app.showTab('stream'); };
  return (
    <FoldCard id="samples" title="Samples" hint="public datasets, one click to stream" defaultOpen={false}>
      <dl id="sample-list" className="m-0 mt-1 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
        {CATALOG.map((group) => (
          <div key={group.format} className="contents">
            <dt className="text-xs font-medium text-muted-foreground">{group.label}</dt>
            <dd className="m-0 flex flex-wrap gap-1.5">
              {group.samples.map((s) => (
                <Tip key={s.id} text={`${s.origin}\n${s.src}`}>
                  <Button size="sm" data-sample={s.id} onClick={() => load(s)}>{s.label}</Button>
                </Tip>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <p className="m-0 mt-3 text-xs text-muted-foreground">Hosted by third parties and credited in each tooltip; none is ours unless it says Iconem.</p>
    </FoldCard>
  );
}
