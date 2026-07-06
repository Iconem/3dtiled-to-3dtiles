import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { crossLinks } from '@/lib/layout.shared';

// Same cross-links as the top navbar (see layout.shared.tsx), rendered in the sidebar's FOOTER slot.
// Fumadocs' own Sidebar renders the GitHub-icon/theme-toggle row BEFORE the `footer` slot content in
// DOM order (both siblings in the same flex-col container) — `order-first` flips that visually so
// these links sit ABOVE that row, with GitHub/theme staying pinned as the very last thing at the
// bottom, without needing to override fumadocs' own Sidebar component.
function SidebarFooterLinks() {
  return (
    <div className="flex flex-col gap-1 order-first">
      {crossLinks.map((link) =>
        'url' in link ? (
          <a
            key={link.url}
            href={link.url}
            target={link.external ? '_blank' : undefined}
            rel={link.external ? 'noreferrer' : undefined}
            className="text-fd-muted-foreground hover:text-fd-accent-foreground text-sm py-1"
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
      sidebar={{ footer: <SidebarFooterLinks /> }}
    >
      {children}
    </DocsLayout>
  );
}
