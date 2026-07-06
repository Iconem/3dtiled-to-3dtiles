import fs from 'node:fs';
import path from 'node:path';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
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
    <DocsPage full>
      <DocsTitle>API Reference</DocsTitle>
      <DocsDescription className="mb-0">
        Interactive reference for the tile-server&apos;s HTTP API, generated from its OpenAPI spec.
      </DocsDescription>
      <DocsBody className="max-w-none">
        <ScalarClient spec={spec} />
      </DocsBody>
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
