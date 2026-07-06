import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { crossLinks } from '@/lib/layout.shared';

// Same cross-links as the top navbar (see layout.shared.tsx), rendered in the sidebar's FOOTER slot.
// Fumadocs' own Sidebar renders the GitHub-icon/theme-toggle row BEFORE the `footer` slot content in
// DOM order (both siblings in the same flex-col container) — `order-first` flips that visually so
// these links sit ABOVE that row, with GitHub/theme staying pinned as the very last thing at the
// bottom, without needing to override fumadocs' own Sidebar component.
//
// Styling matches fumadocs' own page-tree `SidebarItem` exactly (see its `itemVariants` in
// fumadocs-ui/dist/layouts/docs/slots/sidebar.js: rounded-lg row, p-2, hover:bg-fd-accent/50) so
// these read as more nav items, not a visually distinct add-on. `pb-2` on the wrapper gives the
// group its own breathing room above the GitHub/theme row below it.
function SidebarFooterLinks() {
  return (
    <div className="flex flex-col gap-0.5 pb-2 order-first">
      {crossLinks.map((link) =>
        'url' in link ? (
          <a
            key={link.url}
            href={link.url}
            target={link.external ? '_blank' : undefined}
            rel={link.external ? 'noreferrer' : undefined}
            className="flex items-center rounded-lg p-2 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 hover:transition-none"
          >
            {link.text}
          </a>
        ) : null,
      )}
    </div>
  );
}

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      links={[]}
      // defaultOpenLevel starts counting from 1 (0 = every folder collapsed, fumadocs-ui's default) —
      // "Guide" and "Reference notes" are both first-level folders, so 1 opens them both by default.
      sidebar={{ footer: <SidebarFooterLinks />, defaultOpenLevel: 1 }}
    >
      {children}
    </DocsLayout>
  );
}
