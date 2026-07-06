'use client';

// Without this the component renders with none of Scalar's own layout/theme CSS — no sidebar chrome,
// no panel backgrounds, just the raw unstyled content flowing through whatever Fumadocs' global styles
// happen to apply (the CDN-script integration in packages/tile-server/homepage-live.js gets this for
// free via a plain <link>; the React component doesn't bundle its CSS automatically).
import '@scalar/api-reference-react/style.css';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import type { AnyApiReferenceConfiguration } from '@scalar/api-reference-react';

// Scalar's React component reaches for `window`/DOM APIs internally, so it must run client-side —
// this file is the client boundary. The parsed OpenAPI document is read server-side (see page.tsx)
// and passed in as a plain prop; we never fetch it again here.
//
// Config mirrors packages/tile-server/homepage-live.js's SCALAR_CONFIG (same product, same defaults)
// minus the bits that only make sense for that standalone CDN-script integration (`agent.disabled`
// isn't needed here since embedding via the React component never renders the "Ask AI" button;
// `showToolbar` is likewise dropped — it's part of the raw/deprecated config shape but omitted from
// `ApiReferenceConfigurationWithSource`'s public type, per @scalar/types/api-reference).
export function ScalarClient({ spec }: { spec: Record<string, unknown> }) {
  const configuration: AnyApiReferenceConfiguration = {
    content: spec,
    layout: 'modern',
    defaultOpenAllTags: true,
    theme: 'default',
    hideClientButton: false,
    showSidebar: true,
    showDeveloperTools: 'localhost',
    operationTitleSource: 'summary',
    persistAuth: false,
    isEditable: false,
    hideModels: false,
    documentDownloadType: 'both',
    hideTestRequestButton: false,
    hideSearch: false,
    showOperationId: false,
    hideDarkModeToggle: false,
    withDefaultFonts: true,
    defaultOpenFirstTag: true,
    expandAllModelSections: false,
    expandAllResponses: false,
    expandAllSchemaProperties: false,
    orderSchemaPropertiesBy: 'alpha',
    orderRequiredPropertiesFirst: true,
    modelsSectionLabel: 'Models',
  };

  return <ApiReferenceReact configuration={configuration} />;
}
