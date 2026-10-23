import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

export const revalidate = false;

// staticGET exports the whole Orama index as one JSON payload — the client (RootProvider
// search type 'static' in layout.tsx) downloads it once and searches locally. This works
// identically in dev AND under `output: 'export'` (where this route becomes a static file),
// which is what makes the GitHub Pages deployment searchable.
export const { staticGET: GET } = createFromSource(source, {
  // https://docs.orama.com/docs/orama-js/supported-languages
  language: 'english',
});
