import fs from 'node:fs';
import path from 'node:path';
import { DocsPage } from 'fumadocs-ui/layouts/docs/page';
import type { Metadata } from 'next';
import { ScalarClient } from './ScalarClient';

// apps/docs's `dev`/`build` scripts run with cwd = apps/docs (see package.json), so the tile-server
// package sits two levels up in the workspace.
const OPENAPI_PATH = path.join(process.cwd(), '..', '..', 'packages', 'tile-server', 'openapi.json');

function readOpenApiSpec(): Record<string, unknown> {
  const raw = fs.readFileSync(OPENAPI_PATH, 'utf-8');
  return JSON.parse(raw);
}

export default function Page() {
  const spec = readOpenApiSpec();

  return (
    // No <DocsBody> here on purpose — it applies Tailwind Typography's `prose` class, which is meant
    // for MDX prose (headings/paragraphs/lists) and visibly fights Scalar's own carefully-styled
    // 3-pane layout (oversized default SVG sizing, overridden heading/spacing rules, etc. — this is
    // what "looks weird" turned out to be, compounded by the missing style.css import in
    // ScalarClient.tsx). Also drop the breadcrumb/footer chrome — Scalar has its own header already.
    <DocsPage full breadcrumb={{ enabled: false }} footer={{ enabled: false }}>
      <ScalarClient spec={spec} />
    </DocsPage>
  );
}

export function generateMetadata(): Metadata {
  const spec = readOpenApiSpec();
  const info = (spec.info ?? {}) as { title?: string; description?: string };

  return {
    title: info.title ? `${info.title} — API Reference` : 'API Reference',
    description: info.description,
  };
}
