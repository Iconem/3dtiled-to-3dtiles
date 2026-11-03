import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import Script from 'next/script';

const inter = Inter({
  subsets: ['latin'],
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        {/* static search: the /api/search route exports the whole Orama index (staticGET) and the
            client searches locally — same behavior in dev and in the `output: 'export'` GitHub Pages
            build. `from` carries the Pages basePath (client fetches aren't basePath-prefixed). */}
        <RootProvider
          search={{
            options: {
              type: 'static',
              api: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/api/search`,
            },
          }}
        >
          {children}
        </RootProvider>
        {process.env.NEXT_PUBLIC_UMAMI_SRC && process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
          <Script src={process.env.NEXT_PUBLIC_UMAMI_SRC} data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
            data-exclude-search="true" data-exclude-hash="true" />
        )}
      </body>
    </html>
  );
}
