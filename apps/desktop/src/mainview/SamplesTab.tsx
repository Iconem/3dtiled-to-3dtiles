/**
 * Samples — a real dataset for every format the middleware reads, one click into Build.
 */
import { Button } from '@/components/ui/button';
import type { AppModel } from './App';
import { CATALOG, type Sample } from './catalog';
import { Card } from './components/Card';
import { Chip, FieldLabel, Hint } from './components/bits';
import { newId } from './library';

export function SamplesTab({ app }: { app: AppModel }) {
  const load = (s: Sample) => { app.loadIntoBuilder({ src: s.src, format: s.format, cache: 'none' }); app.showTab('build'); };
  const save = (s: Sample) => app.updateLib((l) => { l.bookmarks.push({ id: newId(), name: s.label, src: s.src, format: s.format, cache: 'none', addedAt: Date.now() }); });
  return (
    <section>
      <Card>
        <FieldLabel className="mb-[9px]">Every format this middleware reads</FieldLabel>
        <Hint>
          Real, publicly-hosted datasets — one click loads one into <em>Build</em> with the
          right format already selected. Third-party sources are credited; none of this data
          is ours unless it says Iconem.
        </Hint>
        <div id="sample-list" className="mt-3 flex flex-col gap-2">
          {CATALOG.map((group) => (
            <div key={group.format} className="flex flex-col gap-1.5">
              <div className="mt-2.5 flex items-center gap-2 border-b border-border pb-1 text-[12.5px] font-semibold text-foreground">
                {`${group.icon}  ${group.label}`}<Chip>{group.kind}</Chip>
              </div>
              {group.samples.map((s) => (
                <div key={s.id} className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-transparent px-3 py-2 hover:bg-muted/50">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-[7px] text-[13.5px] font-medium">{s.label}<Chip>{s.origin}</Chip></div>
                    <div className="truncate font-mono text-[11.5px] leading-[1.4] text-muted-foreground" title={s.src}>{s.src}</div>
                  </div>
                  <div className="flex flex-none gap-1">
                    <Button size="sm" variant="ghost" onClick={() => load(s)}>Load</Button>
                    <Button size="sm" variant="ghost" onClick={() => save(s)}>Save</Button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}
