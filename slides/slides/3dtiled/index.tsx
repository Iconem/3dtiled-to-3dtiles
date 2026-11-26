import { type DesignSystem, type Page, type SlideMeta, useSlidePageNumber } from '@open-slide/core';
import type { CSSProperties, ReactNode } from 'react';

import logo from './assets/logo.svg';
import viewerOsgb from './assets/viewer-osgb.jpg';
import desktopStream from './assets/desktop-stream.png';
import desktopExport from './assets/desktop-export.png';
import desktopTile from './assets/desktop-tile.png';
import desktopLibrary from './assets/desktop-library.png';
import desktopStreams from './assets/desktop-streams.png';
import terrainBlender from './assets/terrain-blender.jpg';

// Sources of every figure: apps/docs/content/docs (supported-formats, architecture-caching, geometric-error,
// meta-tilesets, aggregate-builder, desktop-app, desktop-tile-raw-input, todo-future-work, planning/*) and CHANGELOG.md.

// ─── Deck kit: the terrain-viewer decks' kit, i.e. open-slide's stock look ────
// White, Geist, hairline rules, soft panels, one restrained accent (the logo's green, darkened for text).

export const design: DesignSystem = {
  palette: { bg: '#ffffff', text: '#0a0a0a', accent: '#15803d' },
  fonts: {
    display:
      '"Geist Variable", Geist, -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif',
    body: '"Geist Variable", Geist, -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif',
  },
  typeScale: { hero: 152, body: 32 },
  radius: 12,
};

const FOOT = '3dtiled · docs.3dtiled.iconem.com';

const ink = {
  text: '#0a0a0a',
  soft: '#404040',
  muted: '#6b6b6b',
  dim: '#a3a3a3',
  rule: '#e4e4e4',
  panel: '#f7f7f7',
};

// One colour per output primitive, used on every page.
const PTS = '#d97706';
const MESH = '#2563eb';
const SPLAT = '#7c3aed';

const mono = '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const shadow = {
  edge: '0 0 0 1px rgba(0, 0, 0, 0.06), 0 1px 0 rgba(0, 0, 0, 0.025)',
  window:
    '0 0 0 1px rgba(0, 0, 0, 0.07), 0 1px 2px rgba(0, 0, 0, 0.04), 0 12px 32px -12px rgba(0, 0, 0, 0.12)',
};

const pad2 = (n: number) => String(n).padStart(2, '0');
const PAD_X = 120;

const fill: CSSProperties = {
  width: '100%',
  height: '100%',
  position: 'relative',
  overflow: 'hidden',
  background: 'var(--osd-bg)',
  color: 'var(--osd-text)',
  fontFamily: 'var(--osd-font-body)',
  letterSpacing: '-0.01em',
  WebkitFontSmoothing: 'antialiased',
};

const Mark = () => (
  <div
    style={{
      position: 'absolute',
      left: PAD_X,
      top: 101,
      width: 16,
      height: 16,
      borderRadius: 4,
      background: 'var(--osd-accent)',
    }}
  />
);

const Footer = () => {
  const { current, total } = useSlidePageNumber();
  return (
    <div
      style={{
        position: 'absolute',
        left: PAD_X,
        right: PAD_X,
        bottom: 44,
        display: 'flex',
        justifyContent: 'space-between',
        fontFamily: mono,
        fontSize: 20,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: ink.muted,
      }}
    >
      <span>{FOOT}</span>
      <span>
        {pad2(current)} / {pad2(total)}
      </span>
    </div>
  );
};

const Eyebrow = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      position: 'absolute',
      left: PAD_X + 28,
      top: 96,
      fontSize: 22,
      lineHeight: '26px',
      fontWeight: 500,
      color: 'var(--osd-accent)',
    }}
  >
    {children}
  </div>
);

const Frame = ({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children: ReactNode }) => (
  <div style={fill}>
    <Mark />
    <Eyebrow>{eyebrow}</Eyebrow>
    <h2
      style={{
        position: 'absolute',
        left: PAD_X,
        right: PAD_X,
        top: 138,
        margin: 0,
        fontFamily: 'var(--osd-font-display)',
        fontSize: 60,
        fontWeight: 500,
        letterSpacing: '-0.03em',
        lineHeight: 1.06,
        whiteSpace: 'nowrap',
      }}
    >
      {title}
    </h2>
    <div style={{ position: 'absolute', left: PAD_X, right: PAD_X, top: 250, bottom: 84 }}>{children}</div>
    <Footer />
  </div>
);

const Bullets = ({ children, size = 28 }: { children: ReactNode; size?: number }) => (
  <ul
    style={{
      listStyle: 'none',
      margin: 0,
      padding: 0,
      display: 'flex',
      flexDirection: 'column',
      fontSize: size,
      lineHeight: 1.38,
      borderBottom: `1px solid ${ink.rule}`,
    }}
  >
    {children}
  </ul>
);

const Li = ({ children, k }: { children: ReactNode; k?: ReactNode }) => (
  <li style={{ padding: '11px 0', borderTop: `1px solid ${ink.rule}` }}>
    {k ? <span style={{ fontWeight: 500, color: ink.text }}>{k} </span> : null}
    <span style={{ color: k ? ink.soft : ink.text }}>{children}</span>
  </li>
);

const Shot = ({
  src,
  caption,
  width = 900,
  height,
  position = '50% 0%',
}: {
  src: string;
  caption?: ReactNode;
  width?: number;
  height?: number;
  position?: string;
}) => (
  <figure style={{ margin: 0, width, flex: 'none' }}>
    <img
      src={src}
      style={{
        width,
        height: height ?? Math.round(width * 0.5625),
        objectFit: 'cover',
        objectPosition: position,
        borderRadius: 12,
        boxShadow: shadow.window,
        display: 'block',
        background: ink.panel,
      }}
    />
    {caption ? (
      <figcaption style={{ fontSize: 20, color: ink.muted, marginTop: 14, lineHeight: 1.35 }}>{caption}</figcaption>
    ) : null}
  </figure>
);

const TwoCol = ({ left, right, leftWidth = 740 }: { left: ReactNode; right: ReactNode; leftWidth?: number }) => (
  <div style={{ display: 'flex', gap: 48, alignItems: 'flex-start' }}>
    <div style={{ width: leftWidth, flex: 'none' }}>{left}</div>
    <div style={{ flex: 1, minWidth: 0 }}>{right}</div>
  </div>
);

const Card = ({
  title,
  children,
  accent = 'var(--osd-accent)',
  style,
}: {
  title: ReactNode;
  children: ReactNode;
  accent?: string;
  style?: CSSProperties;
}) => (
  <div style={{ background: ink.panel, borderRadius: 12, padding: '24px 28px', flex: 1, minWidth: 0, ...style }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em', marginBottom: 10 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: accent, flex: 'none' }} />
      <span>{title}</span>
    </div>
    <div style={{ fontSize: 22, lineHeight: 1.42, color: ink.soft }}>{children}</div>
  </div>
);

const C = ({ children }: { children: ReactNode }) => (
  <span style={{ fontFamily: mono, fontSize: '0.9em', color: ink.text }}>{children}</span>
);

const Row = ({ k, v, w = 220 }: { k: ReactNode; v: ReactNode; w?: number }) => (
  <div style={{ display: 'flex', gap: 24, padding: '12px 0', borderTop: `1px solid ${ink.rule}`, fontSize: 23, lineHeight: 1.35 }}>
    <span style={{ width: w, flex: 'none', fontWeight: 500, color: ink.text }}>{k}</span>
    <span style={{ color: ink.soft }}>{v}</span>
  </div>
);

const Stat = ({ n, label }: { n: ReactNode; label: ReactNode }) => (
  <div style={{ flex: 1, minWidth: 0, borderTop: `1px solid ${ink.rule}`, paddingTop: 20 }}>
    <div style={{ fontSize: 56, fontWeight: 500, letterSpacing: '-0.035em', lineHeight: 1, color: ink.text }}>{n}</div>
    <div style={{ marginTop: 12, fontSize: 20, color: ink.muted, lineHeight: 1.3 }}>{label}</div>
  </div>
);

const Formula = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      fontFamily: mono,
      fontSize: 27,
      background: ink.panel,
      borderRadius: 12,
      padding: '16px 24px',
      color: ink.text,
      lineHeight: 1.5,
    }}
  >
    {children}
  </div>
);

const Box = ({
  children,
  accent = 'var(--osd-accent)',
  w = 300,
  sub,
}: {
  children: ReactNode;
  accent?: string;
  w?: number;
  sub?: ReactNode;
}) => (
  <div
    style={{
      width: w,
      flex: 'none',
      background: '#fff',
      boxShadow: shadow.edge,
      borderTop: `3px solid ${accent}`,
      borderRadius: 12,
      padding: '18px 20px',
      fontSize: 24,
      fontWeight: 500,
      lineHeight: 1.3,
      textAlign: 'center',
      boxSizing: 'border-box',
    }}
  >
    {children}
    {sub ? <div style={{ fontSize: 19, fontWeight: 400, color: ink.muted, marginTop: 6 }}>{sub}</div> : null}
  </div>
);

const Arrow = ({ label }: { label?: ReactNode }) => (
  <div style={{ flex: 1, minWidth: 40, alignSelf: 'center', textAlign: 'center', color: ink.dim }}>
    {label ? <div style={{ fontFamily: mono, fontSize: 18, color: ink.muted, marginBottom: 2 }}>{label}</div> : null}
    <div style={{ fontSize: 32, lineHeight: 1 }}>→</div>
  </div>
);

const Dot = ({ color, size = 12 }: { color: string; size?: number }) => (
  <span style={{ display: 'inline-block', width: size, height: size, borderRadius: 3, background: color, flex: 'none' }} />
);

const Label = ({ children }: { children: ReactNode }) => (
  <div style={{ fontFamily: mono, fontSize: 17, letterSpacing: '0.08em', textTransform: 'uppercase', color: ink.muted, marginBottom: 12 }}>
    {children}
  </div>
);

// ─── Pages ──────────────────────────────────────────────────────────────────

const P1Cover: Page = () => (
  <div style={fill}>
    <Mark />
    <Eyebrow>Open source · MIT</Eyebrow>
    <div style={{ position: 'absolute', left: PAD_X, top: 300, width: 900 }}>
      <h1
        style={{
          fontFamily: 'var(--osd-font-display)',
          fontSize: 152,
          fontWeight: 500,
          letterSpacing: '-0.04em',
          lineHeight: 1,
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 36,
        }}
      >
        <img src={logo} width={128} height={128} alt="" />
        3dtiled
      </h1>
      <p style={{ fontSize: 34, color: ink.soft, margin: '44px 0 0', maxWidth: 860, lineHeight: 1.4 }}>
        Tiled point clouds, meshes and Gaussian splats, streamed as OGC 3D Tiles.
      </p>
      <p style={{ fontFamily: mono, fontSize: 22, color: ink.muted, margin: '40px 0 0' }}>github.com/Iconem/3dtiled-to-3dtiles</p>
    </div>
    <div style={{ position: 'absolute', left: 1100, top: 235, width: 700, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
      {SHAPES.slice(0, 9).map((x) => (
        <div key={x.title} style={{ background: ink.panel, borderRadius: 10, padding: '16px 14px 12px', boxSizing: 'border-box' }}>
          <svg width="100%" viewBox="0 0 268 128" style={{ display: 'block' }}>
            {x.svg}
          </svg>
          <div style={{ fontFamily: mono, fontSize: 15, color: ink.muted, marginTop: 10, whiteSpace: 'nowrap' }}>{x.formats}</div>
        </div>
      ))}
    </div>
    <Footer />
  </div>
);

const SrcItem = ({ color, kind, children }: { color: string; kind?: string; children: ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '9px 0', borderTop: `1px solid ${ink.rule}`, fontSize: 23 }}>
    <Dot color={color} />
    {kind ? <span style={{ width: 100, flex: 'none', fontSize: 19, color: ink.muted }}>{kind}</span> : null}
    <span>{children}</span>
  </div>
);

const P2Overview: Page = () => (
  <Frame eyebrow="Overview" title="Any tiled source, any 3D Tiles client">
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      <div style={{ width: 470, flex: 'none' }}>
        <Label>Sources</Label>
        <SrcItem color={PTS} kind="Points">COPC · Potree · VPC</SrcItem>
        <SrcItem color={MESH} kind="Meshes">I3S · OSGB · 3MX · Nexus</SrcItem>
        <SrcItem color={MESH} kind="Meshes">Bing Maps 3D</SrcItem>
        <SrcItem color={SPLAT} kind="Splats">SOG · RAD · LCC · GeoSplats</SrcItem>
        <SrcItem color={ink.dim} kind="Packages">.3tz · .3dtiles</SrcItem>
      </div>
      <Arrow />
      <Box w={450} sub={<span style={{ fontFamily: mono }}>/stream/tileset.json?format=…&amp;url=…</span>}>
        <div style={{ fontSize: 34 }}>tile-server</div>
        <div style={{ fontSize: 21, fontWeight: 400, color: ink.soft, marginTop: 12 }}>
          reads the source&apos;s hierarchy, decodes one node per request into one GLB
        </div>
      </Box>
      <Arrow />
      <div style={{ width: 400, flex: 'none' }}>
        <Label>Clients</Label>
        <SrcItem color="var(--osd-accent)">CesiumJS · 3DTilesRendererJS</SrcItem>
        <SrcItem color="var(--osd-accent)">Cesium for Unreal · Unity</SrcItem>
        <SrcItem color="var(--osd-accent)">Omniverse · O3DE</SrcItem>
        <SrcItem color="var(--osd-accent)">QGIS · ArcGIS</SrcItem>
        <SrcItem color="var(--osd-accent)">Blender add-on</SrcItem>
      </div>
    </div>
    <div style={{ display: 'flex', gap: 24, marginTop: 56 }}>
      <Card title="Converters" accent={ink.dim}>
        <C>3dtiled &lt;input&gt; &lt;out&gt;</C>: CLI and JS SDK, one package per format.
      </Card>
      <Card title="Middleware">
        <C>packages/tile-server</C>: /stream, /convert, /export, /aggregate, /extract.
      </Card>
      <Card title="Clients" accent={ink.dim}>
        A web viewer and a desktop app.
      </Card>
    </div>
  </Frame>
);

const P3Genesis: Page = () => (
  <Frame eyebrow="Genesis" title="From converters to a server">
    <TwoCol
      leftWidth={1080}
      left={
        <div style={{ borderBottom: `1px solid ${ink.rule}` }}>
          <Row w={170} k="Jun 18" v="First commit: COPC and RAD converters, a viewer" />
          <Row w={170} k="Jun 20–22" v="Streamed SOG, LCC, Potree, I3S; monorepo with a shared core" />
          <Row w={170} k="Jun 22" v="COPC to 3D Tiles live: the tile-server" />
          <Row w={170} k="Jun 29" v="Lazy hierarchies, the cache modes; 3MX, Bing Maps 3D" />
          <Row w={170} k="Jul 1" v="MapTiler GeoSplats live" />
          <Row w={170} k="Aug 22" v="/aggregate mosaics, globe placement, serve CLI" />
          <Row w={170} k="Sep" v="Desktop app, hierarchy explorer, aggregate builder" />
          <Row w={170} k="Nov" v="OSGB, VPC, LCC2, Nexus; one-stop tiler; crop in the browser" />
        </div>
      }
      right={
        <div style={{ paddingTop: 12 }}>
          <Stat n="4 days" label="from the first converter to live streaming" />
        </div>
      }
    />
  </Frame>
);

const P4Idea: Page = () => (
  <Frame eyebrow="Idea" title="Don’t re-tile what is already tiled">
    <p style={{ fontSize: 48, fontWeight: 500, letterSpacing: '-0.025em', lineHeight: 1.25, margin: '20px 0 0', maxWidth: 1500 }}>
      Every source is already a tree of level-of-detail tiles.
    </p>
    <p style={{ fontSize: 32, color: ink.soft, lineHeight: 1.45, margin: '32px 0 0', maxWidth: 1400 }}>
      Map that tree onto a 3D Tiles tree, re-encode each node into one output. The decoder differs per format; the
      output does not.
    </p>
    <div style={{ display: 'flex', gap: 24, marginTop: 80 }}>
      <Card title="TiTiler" accent={ink.dim}>
        A Cloud Optimized GeoTIFF, served as map tiles.
      </Card>
      <Card title="3dtiled">A tiled 3D source, served as 3D Tiles. No re-tiling, no copy.</Card>
    </div>
  </Frame>
);

const P5PushPull: Page = () => (
  <Frame eyebrow="Push and pull" title="Convert everything, or answer each request">
    <Label>Push · /convert, cache=full</Label>
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      <Box w={320} accent={ink.dim} sub="the whole dataset">
        Source
      </Box>
      <Arrow />
      <Box w={320} accent={ink.dim} sub="every node, top-down">
        Walk the tree
      </Box>
      <Arrow />
      <Box w={320} accent={ink.dim} sub="workers, gzip">
        Encode every tile
      </Box>
      <Arrow />
      <Box w={380} accent={ink.dim} sub="any static host">
        Folder · .3tz · .3dtiles
      </Box>
    </div>
    <div style={{ height: 64 }} />
    <Label>Pull · /stream, cache=none (default)</Label>
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      <Box w={320} sub="CesiumJS, Unreal…">
        Client
      </Box>
      <Arrow label="GET tile/3-2-1-0.glb" />
      <Box w={380} sub="no state">
        tile-server
      </Box>
      <Arrow label="range: one node" />
      <Box w={320} sub="S3, HTTP, disk">
        Source
      </Box>
    </div>
    <p style={{ fontSize: 26, color: ink.soft, margin: '56px 0 0', lineHeight: 1.45 }}>
      Same mapping, two directions. <C>/export</C> crawls any served tileset into a folder, so every live format also
      has an offline output.
    </p>
  </Frame>
);

const P6Cache: Page = () => (
  <Frame eyebrow="Cache modes" title="One parameter: how much to keep">
    <div style={{ display: 'flex', gap: 24 }}>
      <Card title={<C>cache=none</C>}>Default. Root only; hierarchy and tiles read when asked.</Card>
      <Card title={<C>cache=refine</C>} accent={ink.dim}>
        The whole tree read in the background once a client goes below the root.
      </Card>
      <Card title={<C>cache=hierarchy</C>} accent={ink.dim}>
        The whole tree in memory before the first answer; tiles per request.
      </Card>
      <Card title={<C>cache=full</C>} accent={ink.dim}>
        Tree and every GLB on disk, served static, kept across restarts.
      </Card>
    </div>
    <div style={{ marginTop: 56, maxWidth: 1100 }}>
      <Label>The same ladder elsewhere</Label>
      <div style={{ borderBottom: `1px solid ${ink.rule}` }}>
        <Row k="Databases" v="view → materialized view → table" />
        <Row k="Web" v="SSR → ISR → SSG" />
        <Row k="Map tiles" v="dynamic tiling → cache on demand → pre-rendered cache" />
      </div>
    </div>
  </Frame>
);

const P7Range: Page = () => (
  <Frame eyebrow="Range requests" title="Byte ranges, never whole files">
    <TwoCol
      leftWidth={900}
      left={
        <>
          <Label>autzen.copc.laz · one remote file</Label>
          <div style={{ display: 'flex', gap: 4, height: 64 }}>
            <div style={{ width: 70, background: 'var(--osd-accent)', borderRadius: '8px 0 0 8px' }} />
            <div style={{ width: 40, background: 'var(--osd-accent)', opacity: 0.5 }} />
            <div style={{ width: 90, background: ink.panel }} />
            <div style={{ width: 120, background: PTS }} />
            <div style={{ width: 80, background: ink.panel }} />
            <div style={{ width: 40, background: 'var(--osd-accent)', opacity: 0.5 }} />
            <div style={{ flex: 1, background: ink.panel, borderRadius: '0 8px 8px 0' }} />
          </div>
          <div style={{ display: 'flex', gap: 28, marginTop: 18, fontSize: 21, color: ink.muted }}>
            <span>
              <Dot color="#15803d" /> header, hierarchy pages
            </span>
            <span>
              <Dot color={PTS} /> one LAZ chunk = one tile
            </span>
          </div>
          <p style={{ fontSize: 26, color: ink.soft, margin: '44px 0 0', lineHeight: 1.45 }}>
            Same reads for Potree, LCC, LCC2, Nexus, RAD and SOG chunks, remote or on disk.
          </p>
          <div style={{ display: 'flex', gap: 40, marginTop: 40 }}>
            <Stat n="30 KB" label="root file that opens all of France: 337 206 COPC tiles as nested VPCs" />
          </div>
        </>
      }
      right={
        <Bullets size={26}>
          <Li k="Fails once">retried, three tries with backoff.</Li>
          <Li k="Keeps failing">502, never an empty tile.</Li>
          <Li k="A burst">32 requests at a time per host.</Li>
          <Li k="Reads under 64 KB apart">merged into one request.</Li>
          <Li k="Host ignores Range">refused, not downloaded.</Li>
        </Bullets>
      }
    />
  </Frame>
);

const MapRow = ({ a, aSub, b, bSub }: { a: string; aSub: string; b: string; bSub: string }) => (
  <div style={{ display: 'flex', alignItems: 'center' }}>
    <div style={{ width: 720, flex: 'none', background: ink.panel, borderRadius: 12, padding: '16px 24px' }}>
      <div style={{ fontSize: 27, fontWeight: 500 }}>{a}</div>
      <div style={{ fontSize: 21, color: ink.muted, marginTop: 4 }}>{aSub}</div>
    </div>
    <Arrow />
    <div style={{ width: 720, flex: 'none', background: '#fff', boxShadow: shadow.edge, borderRadius: 12, padding: '16px 24px' }}>
      <div style={{ fontSize: 27, fontWeight: 500 }}>{b}</div>
      <div style={{ fontSize: 21, color: ink.muted, marginTop: 4 }}>{bSub}</div>
    </div>
  </div>
);

const P8Hierarchy: Page = () => (
  <Frame eyebrow="Hierarchy vs geometry" title="The tree is reused, tiles are converted">
    <div style={{ display: 'flex', justifyContent: 'space-between', width: 1680 }}>
      <Label>Source</Label>
      <Label>3D Tiles</Label>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <MapRow a="Hierarchy" aSub="octree pages, node pages, a manifest; read lazily" b="Tile tree" bSub="implicit subtrees or explicit children" />
      <MapRow a="Node data" aSub="points, meshes or splats; decoded on request" b="Tile content" bSub="one GLB: POINTS, TRIANGLES or KHR_gaussian_splatting" />
      <MapRow a="CRS and bounds" aSub="WKT, EPSG, metadata.xml, model.json" b="Root transform, bounding volumes" bSub="ENU to ECEF on the root; box, region or sphere" />
    </div>
    <div style={{ display: 'flex', gap: 48, marginTop: 48 }}>
      <Stat n="80 s → 0.2 s" label="Potree 1.7, 302 M points: time to a first tileset, with a lazy hierarchy" />
      <Stat n="9.6 s → 0.015 s" label="RAD, 50 M splats: same node set as the eager build" />
    </div>
  </Frame>
);

const Shape = ({ title, formats, children }: { title: string; formats: string; children: ReactNode }) => (
  <div style={{ width: 316, height: 264, background: ink.panel, borderRadius: 12, padding: '18px 22px', boxSizing: 'border-box' }}>
    <svg width={272} height={128} viewBox="0 0 268 128">
      {children}
    </svg>
    <div style={{ fontSize: 25, fontWeight: 500, marginTop: 14 }}>{title}</div>
    <div style={{ fontSize: 21, color: ink.muted, marginTop: 4 }}>{formats}</div>
  </div>
);

/** The source hierarchies, drawn on a 268×128 canvas: the Shapes slide, and the first nine on the cover. */
const SHAPES: { title: string; formats: string; svg: ReactNode }[] = [
  {
    title: 'Octree',
    formats: 'COPC · Potree',
    svg: (
      <>
      <g fill="none" stroke={PTS} strokeWidth={2}>
        <rect x={70} y={4} width={120} height={120} />
        <path d="M130 4 V124 M70 64 H190" />
        <path d="M160 64 V124 M130 94 H190" />
        <path d="M175 94 V124 M160 109 H190" />
      </g>
      </>
    ),
  },
  {
    title: 'Binary AABB tree',
    formats: 'Streamed SOG',
    svg: (
      <>
      <g stroke={SPLAT} strokeWidth={2} fill="#fff">
        <path d="M134 18 L80 64 M134 18 L188 64 M80 64 L52 110 M80 64 L108 110 M188 64 L160 110 M188 64 L216 110" fill="none" />
        <circle cx={134} cy={18} r={11} />
        <circle cx={80} cy={64} r={11} />
        <circle cx={188} cy={64} r={11} />
        <circle cx={52} cy={110} r={11} />
        <circle cx={108} cy={110} r={11} />
        <circle cx={160} cy={110} r={11} />
        <circle cx={216} cy={110} r={11} />
      </g>
      </>
    ),
  },
  {
    title: 'Grid × LOD',
    formats: 'LCC',
    svg: (
      <>
      <g fill="none" stroke={SPLAT} strokeWidth={2}>
        <path d="M40 100 L120 120 L228 92 L148 72 Z" />
        <path d="M80 110 L188 82 M94 86 L174 106" />
        <path d="M40 72 L120 92 L228 64 L148 44 Z" opacity={0.6} />
        <path d="M40 44 L120 64 L228 36 L148 16 Z" opacity={0.35} />
      </g>
      </>
    ),
  },
  {
    title: 'Manifest tree',
    formats: 'LCC2',
    svg: (
      <>
      <g stroke={SPLAT} strokeWidth={2} fill="#fff">
        <path d="M134 16 L54 64 M134 16 L134 64 M134 16 L214 64 M54 64 L30 110 M54 64 L78 110 M134 64 L134 110 M214 64 L190 110 M214 64 L238 110" fill="none" />
        <rect x={122} y={6} width={24} height={20} rx={4} />
        <rect x={42} y={54} width={24} height={20} rx={4} />
        <rect x={122} y={54} width={24} height={20} rx={4} />
        <rect x={202} y={54} width={24} height={20} rx={4} />
        <rect x={18} y={100} width={24} height={20} rx={4} />
        <rect x={66} y={100} width={24} height={20} rx={4} />
        <rect x={122} y={100} width={24} height={20} rx={4} />
        <rect x={178} y={100} width={24} height={20} rx={4} />
        <rect x={226} y={100} width={24} height={20} rx={4} />
      </g>
      </>
    ),
  },
  {
    title: 'Merge tree',
    formats: 'RAD',
    svg: (
      <>
      <g stroke={SPLAT} strokeWidth={2} fill="#fff">
        <path d="M134 16 L70 64 M134 16 L198 64 M70 64 L28 112 M70 64 L58 112 M70 64 L88 112 M70 64 L118 112 M198 64 L170 112 M198 64 L226 112" fill="none" />
        <circle cx={134} cy={16} r={10} />
        <circle cx={70} cy={64} r={10} />
        <circle cx={198} cy={64} r={10} />
        <circle cx={28} cy={112} r={8} />
        <circle cx={58} cy={112} r={8} />
        <circle cx={88} cy={112} r={8} />
        <circle cx={118} cy={112} r={8} />
        <circle cx={170} cy={112} r={8} />
        <circle cx={226} cy={112} r={8} />
      </g>
      </>
    ),
  },
  {
    title: 'DAG',
    formats: 'Nexus',
    svg: (
      <>
      <g stroke={MESH} strokeWidth={2} fill="#fff">
        <path d="M134 16 L80 64 M134 16 L188 64 M80 64 L134 112 M188 64 L134 112 M80 64 L50 112 M188 64 L218 112" fill="none" />
        <circle cx={134} cy={16} r={11} />
        <circle cx={80} cy={64} r={11} />
        <circle cx={188} cy={64} r={11} />
        <circle cx={50} cy={112} r={11} />
        <circle cx={134} cy={112} r={11} fill={MESH} />
        <circle cx={218} cy={112} r={11} />
      </g>
      </>
    ),
  },
  {
    title: 'Paged LOD files',
    formats: 'OSGB · 3MX',
    svg: (
      <>
      <g stroke={MESH} strokeWidth={2} fill="#fff">
        <path d="M40 30 h50 l12 12 v58 h-62 Z" />
        <path d="M128 18 h50 l12 12 v58 h-62 Z" />
        <path d="M128 52 h50 l12 12 v58 h-62 Z" />
        <path d="M210 40 h40 M210 80 h40" fill="none" strokeDasharray="5 5" />
        <path d="M102 64 L124 50 M102 70 L124 86" fill="none" />
      </g>
      </>
    ),
  },
  {
    title: 'Node pages',
    formats: 'I3S / SLPK',
    svg: (
      <>
      <g stroke={MESH} strokeWidth={2} fill="#fff">
        <rect x={30} y={14} width={90} height={104} rx={6} />
        <rect x={148} y={14} width={90} height={104} rx={6} />
        <path d="M46 40 h58 M46 62 h58 M46 84 h40 M164 40 h58 M164 62 h58 M164 84 h40" fill="none" />
      </g>
      </>
    ),
  },
  {
    title: 'Quadkeys',
    formats: 'Bing Maps 3D',
    svg: (
      <>
      <g fill="none" stroke={MESH} strokeWidth={2}>
        <rect x={74} y={4} width={120} height={120} />
        <path d="M134 4 V124 M74 64 H194 M104 4 V64 M74 34 H134" />
      </g>
      <g fill={ink.muted} fontSize={14} fontFamily={mono}>
        <text x={160} y={38}>1</text>
        <text x={98} y={98}>2</text>
        <text x={160} y={98}>3</text>
      </g>
      </>
    ),
  },
  {
    title: 'Voxel grids × LOD',
    formats: 'GeoSplats',
    svg: (
      <>
      <g fill="none" stroke={SPLAT} strokeWidth={2}>
        <rect x={20} y={44} width={60} height={60} />
        <rect x={104} y={44} width={60} height={60} />
        <path d="M134 44 V104 M104 74 H164" />
        <rect x={188} y={44} width={60} height={60} />
        <path d="M203 44 V104 M218 44 V104 M233 44 V104 M188 59 H248 M188 74 H248 M188 89 H248" />
      </g>
      </>
    ),
  },
];

const P9Shapes: Page = () => (
  <Frame eyebrow="Source trees" title="Ten source trees, one 3D Tiles tree">
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {[SHAPES.slice(0, 5), SHAPES.slice(5)].map((row, r) => (
        <div key={r} style={{ display: 'flex', gap: 25 }}>
          {row.map((x) => (
            <Shape key={x.title} title={x.title} formats={x.formats}>
              {x.svg}
            </Shape>
          ))}
        </div>
      ))}
    </div>
  </Frame>
);

const P10Error: Page = () => (
  <Frame eyebrow="Hierarchy vs geometry" title="Geometric error">
    <Formula>pixels = geometricError × screenHeight ÷ (2 × distance × tan(fov ÷ 2))</Formula>
    <p style={{ fontSize: 26, color: ink.soft, margin: '24px 0 0' }}>No source stores it as such. Each reader derives it from one of three things:</p>
    <div style={{ display: 'flex', gap: 24, marginTop: 28 }}>
      <Card title="A stored value">
        Potree, COPC: point spacing ÷ 2<sup>depth</sup>. Nexus, OSGB, 3MX, Bing 3D: their own errors or ranges.
      </Card>
      <Card title="Point or splat density" accent={PTS}>
        RAD, streamed SOG, a VPC with an overview: box diagonal over the cube root of the count.
      </Card>
      <Card title="Box size" accent={ink.dim}>
        I3S, LCC, LCC2, GeoSplats by default. <C>&amp;ge=density</C> uses counts already in the index.
      </Card>
    </div>
    <p style={{ fontSize: 26, color: ink.soft, margin: '40px 0 0', lineHeight: 1.45, maxWidth: 1500 }}>
      Distance is measured to the bounding volume: a loose box refines whenever the camera is inside it. Tight boxes
      matter as much as the error.
    </p>
  </Frame>
);

const Fmt = ({ name, by }: { name: string; by: string }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderTop: `1px solid ${ink.rule}` }}>
    <span style={{ fontSize: 25, fontWeight: 500 }}>{name}</span>
    <span style={{ fontSize: 20, color: ink.muted, textAlign: 'right' }}>{by}</span>
  </div>
);

const FmtCol = ({ color, title, out, children }: { color: string; title: string; out: string; children: ReactNode }) => (
  <div style={{ flex: 1, minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Dot color={color} size={14} />
      <span style={{ fontSize: 30, fontWeight: 500, letterSpacing: '-0.02em' }}>{title}</span>
    </div>
    <div style={{ fontFamily: mono, fontSize: 18, color: ink.muted, margin: '8px 0 14px' }}>{out}</div>
    <div style={{ borderBottom: `1px solid ${ink.rule}` }}>{children}</div>
  </div>
);

const P11Formats: Page = () => (
  <Frame eyebrow="Sources, vendors, outputs" title="Formats">
    <div style={{ display: 'flex', gap: 56 }}>
      <FmtCol color={PTS} title="Points" out="glTF POINTS + LAS attributes">
        <Fmt name="COPC" by="Hobu" />
        <Fmt name="Potree 1.x, 2.0" by="PotreeConverter" />
        <Fmt name="VPC" by="PDAL · QGIS" />
        <Fmt name="I3S point layers" by="Esri" />
      </FmtCol>
      <FmtCol color={MESH} title="Meshes" out="glTF TRIANGLES + textures">
        <Fmt name="I3S / SLPK" by="Esri · OGC" />
        <Fmt name="3MX" by="Bentley ContextCapture" />
        <Fmt name="OSGB" by="ContextCapture · DJI Terra" />
        <Fmt name="Nexus" by="CNR-ISTI · 3DHOP" />
        <Fmt name="Bing Maps 3D" by="Microsoft" />
      </FmtCol>
      <FmtCol color={SPLAT} title="Gaussian splats" out="KHR_gaussian_splatting + SPZ">
        <Fmt name="Streamed SOG" by="PlayCanvas" />
        <Fmt name="LCC, LCC2" by="XGRIDS" />
        <Fmt name="RAD" by="SparkJS" />
        <Fmt name="GeoSplats" by="MapTiler" />
      </FmtCol>
    </div>
    <div style={{ marginTop: 40, fontSize: 24, color: ink.soft, background: ink.panel, borderRadius: 12, padding: '16px 24px' }}>
      <span style={{ fontWeight: 500, color: ink.text }}>Already 3D Tiles:</span> .3tz and .3dtiles served in place ·
      implicit to explicit · b3dm, pnts, glTF 1.0 to 3D Tiles 1.1
    </div>
  </Frame>
);

const P12Aggregate: Page = () => (
  <Frame eyebrow="Aggregate" title="Hundreds of datasets, one URL">
    <TwoCol
      leftWidth={900}
      left={
        <>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Box w={420}>
              <span style={{ fontFamily: mono, fontSize: 22 }}>/aggregate/tileset.json</span>
            </Box>
          </div>
          <div style={{ textAlign: 'center', color: ink.dim, fontSize: 28, margin: '8px 0' }}>↓</div>
          <div style={{ display: 'flex', justifyContent: 'space-around' }}>
            {['cell 0·2', 'cell 1·3·0', 'cell 3·1'].map((c) => (
              <div key={c} style={{ fontFamily: mono, fontSize: 20, color: ink.muted, background: ink.panel, borderRadius: 10, padding: '10px 22px' }}>
                {c}
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'center', color: ink.dim, fontSize: 28, margin: '8px 0' }}>↓</div>
          <div style={{ display: 'flex', justifyContent: 'space-around', padding: '0 30px' }}>
            {[PTS, MESH, PTS, MESH, SPLAT, MESH, PTS].map((c, i) => (
              <span key={i} style={{ width: 36, height: 36, borderRadius: 18, background: c }} />
            ))}
          </div>
          <p style={{ fontSize: 23, color: ink.soft, textAlign: 'center', margin: '24px 0 0', lineHeight: 1.45 }}>
            Each leaf points at the dataset&apos;s own tileset.json, refine ADD.
            <br />
            Potree and COPC go through /stream first.
          </p>
          <div style={{ display: 'flex', gap: 40, marginTop: 36 }}>
            <Stat n="16 ms" label="to build the tree of 692 datasets" />
            <Stat n="65 KB" label="gzipped index of 710 datasets" />
          </div>
        </>
      }
      right={
        <Bullets size={26}>
          <Li k="Select">?set=, ?url= or ?vpc=; filter by format, date, latest.</Li>
          <Li k="Read">each child&apos;s root only, no content.</Li>
          <Li k="Group">flat, mercator or geodetic quadtree.</Li>
          <Li k="Bound">spheres or regions; error twice the largest child.</Li>
          <Li k="Emit">one explicit 3D Tiles 1.1 tileset, cached.</Li>
        </Bullets>
      }
    />
  </Frame>
);

const P13Sets: Page = () => (
  <Frame eyebrow="Aggregate" title="Sets: named, uploaded, or built">
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      <Card title="Named">
        <C>?set=flai</C> from the server&apos;s sets folder. <C>&quot;unlisted&quot;: true</C> opens by name only.
      </Card>
      <Card title="Uploaded">
        <C>POST /aggregate/set</C> returns <C>set=upload-…</C>; kept a week after last use, across restarts.
      </Card>
      <Card title="A VPC" accent={PTS}>
        <C>?vpc=&lt;url&gt;</C>: a PDAL / QGIS virtual point cloud as the set. VPCs may nest.
      </Card>
      <Card title="Aggregate Builder" accent={MESH}>
        <C>/builder</C>: your own groups and metadata; exports a tileset.json or a set manifest.
      </Card>
    </div>
    <div style={{ marginTop: 40, fontFamily: mono, fontSize: 24, color: ink.soft, background: ink.panel, borderRadius: 12, padding: '18px 26px', lineHeight: 1.7 }}>
      <div>/aggregate/ tileset.json · index.json · index.geojson · snap.ndjson</div>
      <div style={{ color: ink.muted }}>&amp;nest=geodetic &amp;bv=region &amp;format=copc &amp;latest=1 &amp;cut=auto</div>
    </div>
  </Frame>
);

const P14Viewer: Page = () => (
  <Frame eyebrow="Clients" title="Web viewer">
    <TwoCol
      leftWidth={1080}
      left={<Shot src={viewerOsgb} width={1080} height={608} caption="demo.3dtiled.iconem.com: Weinan, a ContextCapture OSGB, streamed live" />}
      right={
        <Bullets size={26}>
          <Li k="CesiumJS">and 3DTilesRendererJS, one view</Li>
          <Li k="Presets">a pill per format</Li>
          <Li k="Crop">extract a box to LAS, COPC, GLB, SPZ</Li>
          <Li k="Explorer">walk a hierarchy</Li>
          <Li k="Builder">compose aggregates</Li>
          <Li k="Terrain">snap to ground</Li>
        </Bullets>
      }
    />
  </Frame>
);

const B = ({ children }: { children: ReactNode }) => <b style={{ color: ink.text, fontWeight: 500 }}>{children}</b>;

const P15Desktop: Page = () => (
  <Frame eyebrow="Clients" title="Desktop app">
    <p style={{ fontSize: 26, color: ink.soft, margin: 0 }}>
      The tile-server on your machine. Windows, macOS, Linux. Nothing is uploaded.
    </p>
    <div style={{ display: 'flex', gap: 60, marginTop: 30 }}>
      <Shot src={desktopStream} width={520} height={480} caption={<><B>Stream live</B>: a dataset in, a URL for any client out</>} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Shot src={desktopStreams} width={1000} height={410} caption={<><B>Streams</B>: a status pill per URL, asking it for its tileset</>} />
        <div style={{ marginTop: 30 }}>
          <Bullets size={26}>
            <Li>A row for every URL added, copied or previewed</Li>
            <Li>Rename, reorder, pause, load back into the form; kept across restarts</Li>
          </Bullets>
        </div>
      </div>
    </div>
  </Frame>
);

const P16Desktop2: Page = () => (
  <Frame eyebrow="Clients" title="Export, tile, keep">
    <div style={{ display: 'flex', gap: 60, marginTop: 10 }}>
      <Shot src={desktopExport} width={500} height={520} caption={<><B>Export</B>: a static 3D Tiles folder</>} />
      <Shot src={desktopTile} width={500} height={520} caption={<><B>Tile raw input</B>: one-stop tilers, PDAL to Obj2Tiles, downloaded on first use</>} />
      <Shot src={desktopLibrary} width={500} height={520} caption={<><B>Library</B>: bookmarks, history, samples</>} />
    </div>
  </Frame>
);

const P16Terrain: Page = () => (
  <Frame eyebrow="Clients" title="Terrain">
    <TwoCol
      leftWidth={1060}
      left={<Shot src={terrainBlender} width={1060} height={640} position="0% 0%" caption="The Matterhorn in Blender: Mapterhorn terrain, sky-view factor and a hypsometric tint, all from the Terrain tab" />}
      right={
        <Bullets size={26}>
          <Li k="Any DEM">a library id, a tile template, a COG, a VRT</Li>
          <Li k="Terrain">a quantized-mesh layer.json</Li>
          <Li k="Analyses">hillshade, slope, sky-view factor, TPI, TRI, contours</Li>
          <Li k="Viewer link">paste a Terrain Viewer link, keep its modes, ramp and range</Li>
          <Li k="Local">Terrain Viewer&apos;s tile service, each tile computed on request</Li>
        </Bullets>
      }
    />
  </Frame>
);

const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}>{children}</a>
);

const Repo = ({ repo, color, children }: { repo: string; color: string; children: ReactNode }) => (
  <A href={`https://github.com/${repo}`}>
    <div style={{ display: 'flex', gap: 22, alignItems: 'center', padding: '30px 0', borderTop: `1px solid ${ink.rule}` }}>
      <Dot color={color} />
      <span style={{ fontFamily: mono, fontSize: 24, width: 700, flex: 'none', color: 'var(--osd-accent)' }}>github.com/{repo}</span>
      <span style={{ fontSize: 22, color: ink.soft }}>{children}</span>
    </div>
  </A>
);

const P17Ecosystem: Page = () => (
  <Frame eyebrow="Ecosystem" title="Around 3dtiled">
    <div style={{ borderBottom: `1px solid ${ink.rule}` }}>
      <Repo repo="Iconem/blender_ogc3dtiles" color={MESH}>3D Tiles in Blender through cesium-native</Repo>
      <Repo repo="Iconem/terrain-viewer" color={PTS}>terrain sources compared; the Terrain tab&apos;s tile service</Repo>
      <Repo repo="jo-chemla/3dtiles-samples" color={ink.dim}>public reproducers and sample packages</Repo>
      <Repo repo="WilliamLiu-1997/Gaussian-Splat-Lite" color={SPLAT}>the viewer&apos;s splat renderer, and two tilers</Repo>
    </div>
  </Frame>
);

const P18Roadmap: Page = () => (
  <Frame eyebrow="Roadmap" title="Next">
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24 }}>
      <Card title="COPC in the browser">A 3DTilesRendererJS plugin for COPC, then VPC. No server.</Card>
      <Card title="Point and splat tiler" accent={ink.dim}>
        Raw points and splats to COPC, SOG and 3D Tiles, out of core like PotreeConverter 2.0. Benchmark first.
      </Card>
      <Card title="Spec" accent={ink.dim}>
        3D Tiles 2.0 on glTF 2.1; meshopt for points, which <C>transform=meshopt</C> already writes.
      </Card>
      <Card title="Progress endpoint" accent={ink.dim}>
        Progress for hierarchy and full jobs; <C>tiling=explicit</C> everywhere.
      </Card>
      <Card title="Accuracy" accent={ink.dim}>
        Splat presets compared by eye; errors checked against each format&apos;s own viewer.
      </Card>
      <Card title="Ship" accent={ink.dim}>
        Signed desktop builds; vendored upstream patches dropped once released.
      </Card>
    </div>
  </Frame>
);

const P19Close: Page = () => (
  <div style={fill}>
    <Mark />
    <Eyebrow>3dtiled</Eyebrow>
    <h1
      style={{
        position: 'absolute',
        left: PAD_X,
        top: 220,
        margin: 0,
        fontFamily: 'var(--osd-font-display)',
        fontSize: 120,
        fontWeight: 500,
        letterSpacing: '-0.04em',
        lineHeight: 1,
      }}
    >
      Point it at a URL.
      <br />
      <span style={{ color: 'var(--osd-accent)' }}>Get 3D Tiles.</span>
    </h1>
    <div style={{ position: 'absolute', left: PAD_X, right: PAD_X, top: 560, borderBottom: `1px solid ${ink.rule}` }}>
      {[
        ['docs.3dtiled.iconem.com', 'documentation'],
        ['demo.3dtiled.iconem.com', 'web viewer'],
        ['3dtiled.iconem.com', 'tile-server'],
        ['github.com/Iconem/3dtiled-to-3dtiles', 'source, MIT'],
      ].map(([url, what], i) => (
        <div
          key={url}
          style={{ display: 'flex', gap: 40, alignItems: 'baseline', padding: '18px 0', borderTop: `1px solid ${ink.rule}`, fontFamily: mono, fontSize: 26, color: ink.soft }}
        >
          <span style={{ fontSize: 20, color: 'var(--osd-accent)', letterSpacing: '0.08em' }}>{pad2(i + 1)}</span>
          <span style={{ width: 760 }}>{url}</span>
          <span style={{ color: ink.muted }}>{what}</span>
        </div>
      ))}
    </div>
    <Footer />
  </div>
);

export const meta: SlideMeta = {
  title: '3dtiled',
  createdAt: '2026-11-25T18:34:19.687Z',
};

export default [
  P1Cover,
  P2Overview,
  P9Shapes,
  P11Formats,
  P3Genesis,
  P4Idea,
  P5PushPull,
  P6Cache,
  P7Range,
  P8Hierarchy,
  P10Error,
  P12Aggregate,
  P13Sets,
  P15Desktop,
  P16Desktop2,
  P16Terrain,
  P14Viewer,
  P17Ecosystem,
  P18Roadmap,
  P19Close,
] satisfies Page[];

export const notes: (string | undefined)[] = [
  'Open source, MIT. Tiled 3D formats in, OGC 3D Tiles out, converted when a client asks.',
  'Three parts: offline converters, the live tile-server, the clients. The server is the centre.',
  'Ten shapes of source hierarchy, all mapped onto implicit or explicit 3D Tiles trees.',
  'From supported-formats. Amber points, blue meshes, violet splats.',
  'Dates from CHANGELOG.md. Started 2026-06-18; the live COPC server came four days later.',
  'Map the source tree, do not rebuild it. TiTiler for COGs is the analogy.',
  'Push walks everything once; pull answers one request at a time. /export bridges the two.',
  'cache=none is the default; cache=full is /convert. Same code path either way.',
  'Every source read goes through core/source-fetch.js with these rules.',
  'Two jobs: the tree is read lazily, a node is decoded on request.',
  'The docs page "Geometric error, format by format" has the line of code behind each rule.',
  'A mosaic reads only each child root; clients stream tiles from each source directly.',
  'Uploads are never listed; the set name is a hash of the entries.',
  'Each Streams row says whether its URL answers a tileset. Screenshots from the docs (dark theme).',
  'Export writes a folder; Tile raw input runs the one-stop tilers; the Library keeps a source plus its options.',
  'Terrain Viewer tile service, downloaded on first use and run on this machine. Blender add-on as the client.',
  'Public demo; any preset loads live through 3dtiled.iconem.com.',
  'Every line links to its repository.',
  'From the TODO / future work page and the planning pages.',
  undefined,
];
