import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { crossLinks } from '@/lib/layout.shared';

// Same cross-links as the top navbar (see layout.shared.tsx), but rendered in the sidebar's FOOTER
// slot instead of at its top — keeps the page-tree navigation as the first thing visible when the
// sidebar opens, with these secondary links tucked below next to the GitHub icon/theme toggle.
function SidebarFooterLinks() {
  return (
    <div className="flex flex-col gap-1">
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
