import type { StaticImageData } from 'next/image';

/**
 * A screenshot of the desktop app in the theme the docs are read in: the light capture on the light theme, the dark
 * one on the dark theme. Both are imported from the MDX page, so they are emitted with the page's other assets.
 */
export function AppScreen({ light, dark, alt, caption }: { light: StaticImageData; dark: StaticImageData; alt: string; caption?: string }) {
  const shared = 'mx-auto my-0 h-auto max-w-full rounded-lg border border-fd-border shadow-sm';
  return (
    <figure className="not-prose my-6">
      <img src={light.src} width={light.width} height={light.height} alt={alt} loading="lazy" className={`${shared} block dark:hidden`} />
      <img src={dark.src} width={dark.width} height={dark.height} alt={alt} loading="lazy" className={`${shared} hidden dark:block`} />
      {caption && <figcaption className="mt-2 text-center text-sm text-fd-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}
