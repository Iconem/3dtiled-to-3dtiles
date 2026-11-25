import type { CSSProperties, ReactNode } from 'react';
import type { DesignSystem, Page, SlideMeta } from '@open-slide/core';
import { useSlidePageNumber } from '@open-slide/core';

import logo from './assets/logo.svg';
import viewerOsgb from './assets/viewer-osgb.jpg';
import desktopStream from './assets/desktop-stream.png';
import desktopExport from './assets/desktop-export.png';
import desktopTile from './assets/desktop-tile.png';
import desktopLibrary from './assets/desktop-library.png';
import desktopStreams from './assets/desktop-streams.png';

// Sources of every figure in this deck: apps/docs/content/docs (supported-formats, architecture-caching,
// geometric-error, meta-tilesets, aggregate-builder, desktop-app, todo-future-work, planning/*) and CHANGELOG.md.

export const design: DesignSystem = {
  palette: { bg: '#0b0e12', text: '#e8ecf1', accent: '#22c55e' },
  fonts: {
    display: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
    body: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
  },
  typeScale: { hero: 170, body: 34 },
  radius: 14,
};

// Colours outside the design shape. One colour per output primitive, used everywhere.
const muted = '#8b95a3';
const faint = '#5b6573';
const line = '#262e39';
const panel = '#11161d';
const panel2 = '#161d27';
const PTS = '#f5a524';
const MESH = '#38bdf8';
const SPLAT = '#c084fc';
const mono = 'ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace';

const fill: CSSProperties = {
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  fontFamily: 'var(--osd-font-body)',
  background: 'var(--osd-bg)',
  color: 'var(--osd-text)',
  position: 'relative',
  overflow: 'visible',
};

// ---------------------------------------------------------------- shared pieces

const Footer = () => {
  const { current, total } = useSlidePageNumber();
  return (
    <div
      style={{
        position: 'absolute',
        left: 120,
        right: 120,
        bottom: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 22,
        color: faint,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <img src={logo} width={26} height={26} alt="" />
        <span>3dtiled</span>
      </div>
      <span style={{ fontFamily: mono }}>
        {String(current).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </span>
    </div>
  );
};

const Frame = ({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children: ReactNode }) => (
  <div style={{ ...fill, padding: '84px 120px 0' }}>
    <div
      style={{
        fontSize: 24,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--osd-accent)',
        fontWeight: 600,
      }}
    >
      {eyebrow}
    </div>
    <h2
      style={{
        fontFamily: 'var(--osd-font-display)',
        fontSize: 62,
        fontWeight: 800,
        margin: '12px 0 0',
        lineHeight: 1.15,
        letterSpacing: '-0.015em',
      }}
    >
      {title}
    </h2>
    <div style={{ marginTop: 44 }}>{children}</div>
    <Footer />
  </div>
);

const Code = ({ children, color }: { children: ReactNode; color?: string }) => (
  <span style={{ fontFamily: mono, fontSize: '0.88em', color: color ?? 'var(--osd-text)' }}>{children}</span>
);

const Dot = ({ color, size = 14 }: { color: string; size?: number }) => (
  <span
    style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: size,
      background: color,
      flex: 'none',
    }}
  />
);

const Card = ({
  title,
  children,
  accent,
  style,
}: {
  title: ReactNode;
  children: ReactNode;
  accent?: string;
  style?: CSSProperties;
}) => (
  <div
    style={{
      background: panel,
      border: `1px solid ${line}`,
      borderTop: `3px solid ${accent ?? line}`,
      borderRadius: 'var(--osd-radius)',
      padding: '26px 30px',
      boxSizing: 'border-box',
      ...style,
    }}
  >
    <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.25 }}>{title}</div>
    <div style={{ fontSize: 26, lineHeight: 1.45, color: muted, marginTop: 12 }}>{children}</div>
  </div>
);

const Shot = ({ src, w, h, caption }: { src: string; w: number; h: number; caption: ReactNode }) => (
  <figure style={{ margin: 0, width: w }}>
    <img
      src={src}
      width={w}
      height={h}
      alt=""
      style={{
        display: 'block',
        width: w,
        height: h,
        objectFit: 'cover',
        objectPosition: 'top',
        borderRadius: 12,
        border: `1px solid ${line}`,
      }}
    />
    <figcaption style={{ fontSize: 24, color: muted, marginTop: 16, lineHeight: 1.4 }}>{caption}</figcaption>
  </figure>
);

// SVG helpers
const ArrowDefs = () => (
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill={muted} />
    </marker>
    <marker id="arrA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#22c55e" />
    </marker>
  </defs>
);

const Chip = ({ x, y, w, label, color }: { x: number; y: number; w: number; label: string; color: string }) => (
  <g>
    <rect x={x} y={y} width={w} height={40} rx={8} fill={panel2} stroke={line} />
    <circle cx={x + 22} cy={y + 20} r={7} fill={color} />
    <text x={x + 40} y={y + 27} fontSize={21} fill="#e8ecf1">
      {label}
    </text>
  </g>
);

// ---------------------------------------------------------------- 1. cover

const Cover: Page = () => (
  <div style={{ ...fill, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 160px' }}>
    <svg
      width={640}
      height={640}
      viewBox="0 0 120 120"
      style={{ position: 'absolute', right: -40, top: 220, opacity: 0.07 }}
      fill="none"
    >
      <rect x="20" y="20" width="80" height="80" stroke="#22c55e" strokeWidth="1.2" />
      <path d="M60 20 L60 100 M20 60 L100 60" stroke="#22c55e" strokeWidth="1.2" />
      <path d="M80 60 L80 100 M60 80 L100 80" stroke="#22c55e" strokeWidth="1.2" />
      <path d="M90 80 L90 100 M80 90 L100 90" stroke="#22c55e" strokeWidth="1.2" />
    </svg>
    <img src={logo} width={132} height={132} alt="3dtiled logo" />
    <div style={{ fontSize: 26, letterSpacing: '0.2em', color: muted, marginTop: 52, fontWeight: 600 }}>
      OPEN SOURCE · MIT
    </div>
    <h1
      style={{
        fontFamily: 'var(--osd-font-display)',
        fontSize: 'var(--osd-size-hero)',
        fontWeight: 900,
        margin: '12px 0 0',
        lineHeight: 1,
        letterSpacing: '-0.03em',
      }}
    >
      3dtiled
    </h1>
    <p style={{ fontSize: 44, color: muted, maxWidth: 1180, lineHeight: 1.4, margin: '40px 0 0' }}>
      Tiled point clouds, meshes and Gaussian splats, served as{' '}
      <span style={{ color: 'var(--osd-text)' }}>OGC 3D Tiles</span>: converted on request, read by range
      requests.
    </p>
    <div style={{ marginTop: 60, fontSize: 26, fontFamily: mono, color: faint }}>
      github.com/jo-chemla/3dtiled-to-3dtiles
    </div>
  </div>
);

// ---------------------------------------------------------------- 2. what it is

const WhatItIs: Page = () => (
  <Frame eyebrow="What it is" title="One source URL in, a 3D Tiles tileset out">
    <svg width={1680} height={392} viewBox="0 0 1680 392">
      <ArrowDefs />
      <text x={0} y={14} fontSize={20} fill={faint} letterSpacing="0.12em">
        SOURCE FORMATS
      </text>
      <Chip x={0} y={30} w={330} label="COPC · Potree · VPC" color={PTS} />
      <Chip x={0} y={78} w={330} label="I3S / SLPK" color={MESH} />
      <Chip x={0} y={126} w={330} label="OSGB · 3MX" color={MESH} />
      <Chip x={0} y={174} w={330} label="Nexus · Bing Maps 3D" color={MESH} />
      <Chip x={0} y={222} w={330} label="Streamed SOG · RAD" color={SPLAT} />
      <Chip x={0} y={270} w={330} label="LCC · LCC2 · GeoSplats" color={SPLAT} />
      <Chip x={0} y={318} w={330} label=".3tz · .3dtiles packages" color={muted} />

      <path d="M330 50 C 430 50, 430 196, 530 196" stroke={line} strokeWidth={2} fill="none" />
      <path d="M330 98 C 430 98, 430 196, 530 196" stroke={line} strokeWidth={2} fill="none" />
      <path d="M330 146 C 430 146, 430 196, 530 196" stroke={line} strokeWidth={2} fill="none" />
      <path d="M330 194 L 530 196" stroke={line} strokeWidth={2} fill="none" />
      <path d="M330 242 C 430 242, 430 196, 530 196" stroke={line} strokeWidth={2} fill="none" />
      <path d="M330 290 C 430 290, 430 196, 530 196" stroke={line} strokeWidth={2} fill="none" />
      <path d="M330 338 C 430 338, 430 196, 530 196" stroke={line} strokeWidth={2} fill="none" markerEnd="url(#arr)" />

      <rect x={540} y={56} width={600} height={280} rx={16} fill={panel} stroke="#22c55e" strokeWidth={2} />
      <text x={576} y={112} fontSize={36} fontWeight={800} fill="#e8ecf1">
        tile-server
      </text>
      <text x={576} y={150} fontSize={21} fill={muted} fontFamily={mono}>
        /stream/tileset.json?format=…&amp;url=…
      </text>
      <text x={576} y={214} fontSize={25} fill="#e8ecf1">
        reads the source&apos;s own hierarchy
      </text>
      <text x={576} y={246} fontSize={25} fill={muted}>
        → a 3D Tiles tree
      </text>
      <text x={576} y={290} fontSize={25} fill="#e8ecf1">
        decodes one node per request
      </text>
      <text x={576} y={322} fontSize={25} fill={muted}>
        → one glTF tile (GLB)
      </text>

      <path d="M1140 196 C 1240 196, 1240 74, 1340 74" stroke={line} strokeWidth={2} fill="none" markerEnd="url(#arr)" />
      <path d="M1140 196 C 1240 196, 1240 134, 1340 134" stroke={line} strokeWidth={2} fill="none" markerEnd="url(#arr)" />
      <path d="M1140 196 C 1240 196, 1240 194, 1340 194" stroke={line} strokeWidth={2} fill="none" markerEnd="url(#arr)" />
      <path d="M1140 196 C 1240 196, 1240 254, 1340 254" stroke={line} strokeWidth={2} fill="none" markerEnd="url(#arr)" />
      <path d="M1140 196 C 1240 196, 1240 314, 1340 314" stroke={line} strokeWidth={2} fill="none" markerEnd="url(#arr)" />

      <text x={1350} y={14} fontSize={20} fill={faint} letterSpacing="0.12em">
        ANY 3D TILES CLIENT
      </text>
      <Chip x={1350} y={54} w={330} label="CesiumJS · 3DTilesRendererJS" color="#22c55e" />
      <Chip x={1350} y={114} w={330} label="Cesium for Unreal · Unity" color="#22c55e" />
      <Chip x={1350} y={174} w={330} label="Omniverse · O3DE" color="#22c55e" />
      <Chip x={1350} y={234} w={330} label="QGIS · ArcGIS" color="#22c55e" />
      <Chip x={1350} y={294} w={330} label="Blender add-on" color="#22c55e" />
    </svg>
    <div style={{ display: 'flex', gap: 30, marginTop: 40 }}>
      <Card title="Offline converters" accent={faint} style={{ flex: 1 }}>
        <Code color={muted}>3dtiled &lt;input&gt; &lt;out&gt;</Code>: a CLI and JS SDK, one package per format
      </Card>
      <Card title="Live middleware" accent="#22c55e" style={{ flex: 1 }}>
        <Code color={muted}>packages/tile-server</Code>: /stream, /convert, /export, /aggregate, /extract
      </Card>
      <Card title="Clients" accent={faint} style={{ flex: 1 }}>
        A web viewer (CesiumJS + 3DTilesRendererJS) and a desktop app
      </Card>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 3. genesis

const Milestone = ({
  x,
  above,
  date,
  children,
}: {
  x: number;
  above: boolean;
  date: string;
  children: ReactNode;
}) => (
  <>
    <div
      style={{
        position: 'absolute',
        left: x - 9,
        top: 291,
        width: 18,
        height: 18,
        borderRadius: 18,
        background: 'var(--osd-bg)',
        border: '4px solid var(--osd-accent)',
        boxSizing: 'border-box',
      }}
    />
    <div
      style={{
        position: 'absolute',
        left: x - 170,
        width: 340,
        textAlign: 'center',
        ...(above ? { bottom: 640 - 272 } : { top: 330 }),
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--osd-accent)', fontFamily: mono }}>{date}</div>
      <div style={{ fontSize: 24, lineHeight: 1.4, marginTop: 8, color: 'var(--osd-text)' }}>{children}</div>
    </div>
  </>
);

const Genesis: Page = () => (
  <Frame eyebrow="Genesis · 2026" title="From offline converters to a live middleware">
    <p style={{ fontSize: 30, color: muted, margin: '-16px 0 0', lineHeight: 1.45, maxWidth: 1500 }}>
      It began as converters from tiled splat and point-cloud formats to 3D Tiles. Streaming COPC by range
      requests worked on day five, and the project turned into a server.
    </p>
    <div style={{ position: 'relative', width: 1680, height: 640, marginTop: -60 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 299, height: 2, background: line }} />
      <Milestone x={180} above date="Jun 18">
        First commit: COPC and RAD converters, and a viewer
      </Milestone>
      <Milestone x={369} above={false} date="Jun 20–22">
        Streamed SOG, LCC, Potree, I3S; a monorepo with a shared core
      </Milestone>
      <Milestone x={557} above date="Jun 22">
        Live COPC → 3D Tiles: the “TiTiler for 3D” tile-server
      </Milestone>
      <Milestone x={746} above={false} date="Jun 29">
        Lazy hierarchies, the cache continuum; 3MX and Bing 3D
      </Milestone>
      <Milestone x={934} above date="Jul 1–2">
        MapTiler GeoSplats live; bbox and error-aware extract
      </Milestone>
      <Milestone x={1123} above={false} date="Aug 22">
        /aggregate mosaics, /stats, globe placement, serve CLI
      </Milestone>
      <Milestone x={1311} above date="Sep 11–17">
        Desktop app, hierarchy explorer, export, aggregate builder
      </Milestone>
      <Milestone x={1500} above={false} date="Nov">
        OSGB, VPC, LCC2, Nexus; one-stop tiler; crop in the browser
      </Milestone>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 4. the idea

const Idea: Page = () => (
  <Frame eyebrow="The idea" title="Don’t re-tile what is already tiled">
    <div style={{ display: 'flex', gap: 80, marginTop: 30 }}>
      <div style={{ width: 8, background: 'var(--osd-accent)', borderRadius: 4, flex: 'none' }} />
      <div>
        <p style={{ fontSize: 54, fontWeight: 700, lineHeight: 1.3, margin: 0, maxWidth: 1450 }}>
          Every source format is already a spatial tree of pre-tiled, level-of-detail content.
        </p>
        <p style={{ fontSize: 38, color: muted, lineHeight: 1.5, margin: '44px 0 0', maxWidth: 1450 }}>
          So 3dtiled maps that tree onto a 3D Tiles tree, and re-encodes each node into one shared output. The
          decode differs per format; the output is uniform.
        </p>
      </div>
    </div>
    <div
      style={{
        marginTop: 90,
        display: 'flex',
        gap: 60,
        fontSize: 32,
        alignItems: 'baseline',
      }}
    >
      <span style={{ color: faint, fontSize: 24, letterSpacing: '0.16em' }}>ANALOGY</span>
      <span>
        <b>TiTiler</b> <span style={{ color: muted }}>serves a Cloud Optimized GeoTIFF as map tiles.</span>{' '}
        <b>3dtiled</b> <span style={{ color: muted }}>does it for 3D: no re-tiling, no copy.</span>
      </span>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 5. push vs pull

const Box = ({
  x,
  y,
  w,
  h,
  title,
  sub,
  stroke,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  stroke?: string;
}) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={12} fill={panel} stroke={stroke ?? line} strokeWidth={2} />
    <text x={x + w / 2} y={y + (sub ? h / 2 - 6 : h / 2 + 9)} fontSize={26} fontWeight={700} fill="#e8ecf1" textAnchor="middle">
      {title}
    </text>
    {sub ? (
      <text x={x + w / 2} y={y + h / 2 + 28} fontSize={20} fill={muted} textAnchor="middle">
        {sub}
      </text>
    ) : null}
  </g>
);

const PushPull: Page = () => (
  <Frame eyebrow="Mindset" title="Push everything once, or pull what is asked">
    <svg width={1680} height={600} viewBox="0 0 1680 600">
      <ArrowDefs />
      <text x={0} y={30} fontSize={24} fontWeight={700} fill={faint} letterSpacing="0.14em">
        PUSH · OFFLINE CONVERTER, cache=full
      </text>
      <Box x={0} y={60} w={300} h={110} title="Source" sub="the whole dataset" />
      <Box x={400} y={60} w={340} h={110} title="Walk the hierarchy" sub="top-down, every node" />
      <Box x={840} y={60} w={340} h={110} title="Encode every tile" sub="workers, gzip" />
      <Box x={1280} y={60} w={400} h={110} title="Folder · .3tz · .3dtiles" sub="any static host" />
      <line x1={300} y1={115} x2={396} y2={115} stroke={muted} strokeWidth={2} markerEnd="url(#arr)" />
      <line x1={740} y1={115} x2={836} y2={115} stroke={muted} strokeWidth={2} markerEnd="url(#arr)" />
      <line x1={1180} y1={115} x2={1276} y2={115} stroke={muted} strokeWidth={2} markerEnd="url(#arr)" />

      <text x={0} y={262} fontSize={24} fontWeight={700} fill="#22c55e" letterSpacing="0.14em">
        PULL · LIVE /stream, cache=none (default)
      </text>
      <Box x={0} y={290} w={300} h={300} title="Client" sub="CesiumJS, Unreal…" />
      <Box x={690} y={290} w={300} h={300} title="tile-server" sub="no state needed" stroke="#22c55e" />
      <Box x={1380} y={290} w={300} h={300} title="Source" sub="S3, HTTP, disk" />

      <line x1={300} y1={345} x2={686} y2={345} stroke="#22c55e" strokeWidth={2} markerEnd="url(#arrA)" />
      <text x={493} y={333} fontSize={21} fill="#e8ecf1" textAnchor="middle" fontFamily={mono}>
        GET tileset.json
      </text>
      <line x1={990} y1={375} x2={1376} y2={375} stroke={muted} strokeWidth={2} markerEnd="url(#arr)" />
      <text x={1183} y={363} fontSize={21} fill={muted} textAnchor="middle">
        range: header + root hierarchy
      </text>

      <line x1={300} y1={455} x2={686} y2={455} stroke="#22c55e" strokeWidth={2} markerEnd="url(#arrA)" />
      <text x={493} y={443} fontSize={21} fill="#e8ecf1" textAnchor="middle" fontFamily={mono}>
        GET tile/3-2-1-0.glb
      </text>
      <line x1={990} y1={485} x2={1376} y2={485} stroke={muted} strokeWidth={2} markerEnd="url(#arr)" />
      <text x={1183} y={473} fontSize={21} fill={muted} textAnchor="middle">
        range: that one node
      </text>
      <line x1={686} y1={545} x2={304} y2={545} stroke="#22c55e" strokeWidth={2} markerEnd="url(#arrA)" />
      <text x={493} y={533} fontSize={21} fill="#e8ecf1" textAnchor="middle">
        GLB, decoded and encoded now
      </text>
    </svg>
    <p style={{ fontSize: 28, color: muted, margin: '20px 0 0', lineHeight: 1.45 }}>
      Same mapping, opposite direction. <Code color="#e8ecf1">/export</Code> crawls any served tileset into a
      folder, so every live adapter also has an offline output.
    </p>
  </Frame>
);

// ---------------------------------------------------------------- 6. cache continuum

const Stop = ({
  name,
  tag,
  children,
  strong,
}: {
  name: string;
  tag: string;
  children: ReactNode;
  strong?: boolean;
}) => (
  <div
    style={{
      flex: 1,
      background: panel,
      border: `1px solid ${strong ? 'var(--osd-accent)' : line}`,
      borderRadius: 'var(--osd-radius)',
      padding: '26px 28px',
      height: 300,
      boxSizing: 'border-box',
    }}
  >
    <div style={{ fontFamily: mono, fontSize: 30, fontWeight: 700, color: strong ? 'var(--osd-accent)' : 'var(--osd-text)' }}>
      {name}
    </div>
    <div style={{ fontSize: 22, color: faint, marginTop: 6, fontFamily: mono }}>{tag}</div>
    <div style={{ fontSize: 26, color: muted, marginTop: 18, lineHeight: 1.45 }}>{children}</div>
  </div>
);

const Analogy = ({ field, a, b, c }: { field: string; a: string; b: string; c: string }) => (
  <div style={{ display: 'flex', fontSize: 26, lineHeight: 1.5 }}>
    <span style={{ width: 220, color: faint }}>{field}</span>
    <span style={{ color: muted }}>
      {a} <span style={{ color: faint }}>→</span> {b} <span style={{ color: faint }}>→</span> {c}
    </span>
  </div>
);

const CacheModes: Page = () => (
  <Frame eyebrow="Mindset" title={<>One parameter: how much to materialize</>}>
    <svg width={1680} height={70} viewBox="0 0 1680 70">
      <ArrowDefs />
      <line x1={0} y1={35} x2={1672} y2={35} stroke={muted} strokeWidth={2} markerEnd="url(#arr)" />
      <text x={0} y={20} fontSize={22} fill={faint}>
        nothing kept · fast first answer
      </text>
      <text x={1680} y={20} fontSize={22} fill={faint} textAnchor="end">
        everything on disk · slow first answer, then static
      </text>
    </svg>
    <div style={{ display: 'flex', gap: 28, marginTop: 20 }}>
      <Stop name="cache=none" tag="default · /stream" strong>
        Root only. Hierarchy chunks and tiles are read when asked. Nothing persisted.
      </Stop>
      <Stop name="cache=refine" tag="/stream">
        The whole tree is read in the background once a client asks below the root.
      </Stop>
      <Stop name="cache=hierarchy" tag="/stream">
        The whole tree in RAM before the first answer; tiles still per request.
      </Stop>
      <Stop name="cache=full" tag="/convert">
        Tree and every GLB written to disk once, served static, survives a restart.
      </Stop>
    </div>
    <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Analogy field="Databases" a="view" b="materialized view" c="table" />
      <Analogy field="Web" a="SSR" b="ISR" c="SSG" />
      <Analogy field="GIS tiles" a="dynamic tiling" b="cache on demand" c="pre-rendered tile cache" />
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 7. range requests

const Rule = ({ when, then }: { when: string; then: string }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <span style={{ fontSize: 24, color: faint }}>{when}</span>
    <span style={{ fontSize: 28, color: 'var(--osd-text)' }}>{then}</span>
  </div>
);

const Stat = ({ value, children }: { value: string; children: ReactNode }) => (
  <div style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 24 }}>
    <span style={{ fontSize: 56, fontWeight: 800, color: 'var(--osd-accent)', whiteSpace: 'nowrap' }}>{value}</span>
    <span style={{ fontSize: 25, color: muted, lineHeight: 1.4 }}>{children}</span>
  </div>
);

const RangeReads: Page = () => (
  <Frame eyebrow="Mindset" title="Read byte ranges, never whole files">
    <div style={{ display: 'flex', gap: 70 }}>
      <svg width={900} height={470} viewBox="0 0 900 470">
        <ArrowDefs />
        <text x={0} y={28} fontSize={22} fill={faint} fontFamily={mono}>
          autzen.copc.laz · one remote file
        </text>
        <rect x={0} y={200} width={900} height={70} rx={8} fill={panel} stroke={line} />
        <rect x={0} y={200} width={70} height={70} rx={8} fill="#22c55e" opacity={0.85} />
        <rect x={74} y={200} width={40} height={70} fill="#22c55e" opacity={0.55} />
        <rect x={130} y={204} width={86} height={62} fill={panel2} />
        <rect x={222} y={204} width={60} height={62} fill={panel2} />
        <rect x={288} y={204} width={110} height={62} fill={PTS} opacity={0.85} />
        <rect x={404} y={204} width={74} height={62} fill={panel2} />
        <rect x={484} y={204} width={40} height={62} fill="#22c55e" opacity={0.55} />
        <rect x={530} y={204} width={96} height={62} fill={panel2} />
        <rect x={632} y={204} width={70} height={62} fill={panel2} />
        <rect x={708} y={204} width={88} height={62} fill={panel2} />
        <rect x={802} y={204} width={94} height={62} fill={panel2} />
        <text x={0} y={300} fontSize={20} fill={muted}>
          header
        </text>
        <text x={74} y={322} fontSize={20} fill={muted}>
          hierarchy page
        </text>
        <text x={288} y={300} fontSize={20} fill={muted}>
          one LAZ chunk = one node
        </text>

        <text x={0} y={92} fontSize={22} fill="#e8ecf1" fontFamily={mono}>
          tileset.json
        </text>
        <path d="M60 104 L 60 196" stroke="#22c55e" strokeWidth={2} markerEnd="url(#arrA)" />
        <path d="M80 104 C 90 150, 94 160, 94 196" stroke="#22c55e" strokeWidth={2} fill="none" markerEnd="url(#arrA)" />
        <text x={250} y={140} fontSize={22} fill="#e8ecf1" fontFamily={mono}>
          tile/2-1-0-1.glb
        </text>
        <path d="M343 152 L 343 200" stroke={PTS} strokeWidth={2} markerEnd="url(#arr)" />
        <text x={470} y={92} fontSize={22} fill="#e8ecf1" fontFamily={mono}>
          deeper subtree
        </text>
        <path d="M504 104 L 504 200" stroke="#22c55e" strokeWidth={2} markerEnd="url(#arrA)" />

        <text x={0} y={400} fontSize={24} fill={muted}>
          The same reads for Potree, LCC, LCC2, Nexus, RAD, SOG chunks,
        </text>
        <text x={0} y={434} fontSize={24} fill={muted}>
          on a remote host or on local disk.
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22, flex: 1 }}>
        <Rule when="A read fails once (reset, 429, 5xx)" then="Retried, three tries with backoff" />
        <Rule when="It keeps failing" then="502, never an empty 200 or tile" />
        <Rule when="A burst of requests" then="32 at a time per host, halved under load" />
        <Rule when="Reads under 64 KB apart" then="Merged into one request" />
        <Rule when="The host ignores Range" then="Refused, not downloaded" />
      </div>
    </div>
    <div style={{ display: 'flex', gap: 60, marginTop: 28, borderTop: `1px solid ${line}`, paddingTop: 26 }}>
      <Stat value="26 KB">read in 8 requests to serve the tileset.json of a remote 10 MB .3dtiles package</Stat>
      <Stat value="30 KB">root file opens all of France: 337 206 COPC tiles as nested VPCs</Stat>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 8. hierarchy vs geometry

const MapRow = ({ left, leftSub, right, rightSub }: { left: string; leftSub: string; right: string; rightSub: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
    <div
      style={{
        width: 700,
        background: panel,
        border: `1px solid ${line}`,
        borderRadius: 12,
        padding: '18px 28px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ fontSize: 30, fontWeight: 700 }}>{left}</div>
      <div style={{ fontSize: 24, color: muted, marginTop: 4 }}>{leftSub}</div>
    </div>
    <svg width={280} height={40} viewBox="0 0 280 40">
      <ArrowDefs />
      <line x1={20} y1={20} x2={256} y2={20} stroke="#22c55e" strokeWidth={2} markerEnd="url(#arrA)" />
    </svg>
    <div
      style={{
        width: 700,
        background: panel,
        border: `1px solid #22c55e55`,
        borderRadius: 12,
        padding: '18px 28px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ fontSize: 30, fontWeight: 700 }}>{right}</div>
      <div style={{ fontSize: 24, color: muted, marginTop: 4 }}>{rightSub}</div>
    </div>
  </div>
);

const BigNumber = ({ label, from, to, note }: { label: string; from: string; to: string; note: string }) => (
  <div style={{ flex: 1, borderLeft: `3px solid var(--osd-accent)`, paddingLeft: 30 }}>
    <div style={{ fontSize: 24, color: faint }}>{label}</div>
    <div style={{ fontSize: 54, fontWeight: 800, marginTop: 6 }}>
      <span style={{ color: muted, fontWeight: 600 }}>{from}</span>
      <span style={{ color: faint, margin: '0 18px' }}>→</span>
      <span style={{ color: 'var(--osd-accent)' }}>{to}</span>
    </div>
    <div style={{ fontSize: 24, color: muted, marginTop: 4 }}>{note}</div>
  </div>
);

const HierarchyGeometry: Page = () => (
  <Frame eyebrow="Hierarchy vs geometry" title="The hierarchy is reused, geometry converted per tile">
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 22, color: faint, letterSpacing: '0.14em', width: 1680 }}>
      <span>SOURCE FORMAT</span>
      <span>3D TILES</span>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, marginTop: 14 }}>
      <MapRow
        left="Hierarchy"
        leftSub="octree pages, node pages, a manifest — read lazily, by chunk"
        right="Tile tree"
        rightSub="implicit subtrees or explicit children, built from it"
      />
      <MapRow
        left="Node data"
        leftSub="points, meshes or splats — decoded on request"
        right="Tile content"
        rightSub="one GLB: POINTS, TRIANGLES or KHR_gaussian_splatting"
      />
      <MapRow
        left="CRS and bounds"
        leftSub="WKT, EPSG, metadata.xml, model.json…"
        right="Root transform and volumes"
        rightSub="ENU → ECEF on the root; box, region or sphere"
      />
    </div>
    <div style={{ display: 'flex', gap: 60, marginTop: 52 }}>
      <BigNumber label="Potree 1.7, 302 M points: time to a first tileset" from="~80 s" to="~0.2 s" note="lazy hierarchy (June 29)" />
      <BigNumber label="RAD, 50 M splats: time to a first tileset" from="9.6 s" to="0.015 s" note="same node set as the eager build" />
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 9. hierarchy shapes

const Shape = ({ title, formats, detail, children }: { title: string; formats: string; detail: string; children: ReactNode }) => (
  <div
    style={{
      width: 312,
      height: 304,
      background: panel,
      border: `1px solid ${line}`,
      borderRadius: 'var(--osd-radius)',
      padding: '18px 22px',
      boxSizing: 'border-box',
    }}
  >
    <svg width={268} height={128} viewBox="0 0 268 128">
      {children}
    </svg>
    <div style={{ fontSize: 27, fontWeight: 700, marginTop: 12 }}>{title}</div>
    <div style={{ fontSize: 23, color: 'var(--osd-text)', marginTop: 4 }}>{formats}</div>
    <div style={{ fontSize: 21, color: muted, marginTop: 4, lineHeight: 1.35 }}>{detail}</div>
  </div>
);

const Shapes: Page = () => (
  <Frame eyebrow="Hierarchy vs geometry" title="Ten source hierarchies, one 3D Tiles tree">
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div style={{ display: 'flex', gap: 30 }}>
        <Shape title="Octree" formats="COPC · Potree" detail="hierarchy pages, hierarchy.bin">
          <g fill="none" stroke={PTS} strokeWidth={2}>
            <rect x={70} y={4} width={120} height={120} />
            <path d="M130 4 V124 M70 64 H190" />
            <path d="M160 64 V124 M130 94 H190" />
            <path d="M175 94 V124 M160 109 H190" />
          </g>
        </Shape>
        <Shape title="Binary AABB tree" formats="Streamed SOG" detail="lod-meta.json, WebP chunks">
          <g stroke={SPLAT} strokeWidth={2} fill={panel2}>
            <path d="M134 18 L80 64 M134 18 L188 64 M80 64 L52 110 M80 64 L108 110 M188 64 L160 110 M188 64 L216 110" fill="none" />
            <circle cx={134} cy={18} r={11} />
            <circle cx={80} cy={64} r={11} />
            <circle cx={188} cy={64} r={11} />
            <circle cx={52} cy={110} r={11} />
            <circle cx={108} cy={110} r={11} />
            <circle cx={160} cy={110} r={11} />
            <circle cx={216} cy={110} r={11} />
          </g>
        </Shape>
        <Shape title="Grid × LOD" formats="LCC" detail="Index.bin: offsets into Data.bin">
          <g fill="none" stroke={SPLAT} strokeWidth={2}>
            <path d="M40 100 L120 120 L228 92 L148 72 Z" />
            <path d="M80 110 L188 82 M94 86 L174 106" />
            <path d="M40 72 L120 92 L228 64 L148 44 Z" opacity={0.6} />
            <path d="M40 44 L120 64 L228 36 L148 16 Z" opacity={0.35} />
          </g>
        </Shape>
        <Shape title="Manifest tree" formats="LCC2" detail="nodes name row ranges of shared chunks">
          <g stroke={SPLAT} strokeWidth={2} fill={panel2}>
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
        </Shape>
        <Shape title="Merge tree" formats="RAD (SparkJS)" detail="variable fanout, merged coarse splats">
          <g stroke={SPLAT} strokeWidth={2} fill={panel2}>
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
        </Shape>
      </div>
      <div style={{ display: 'flex', gap: 30 }}>
        <Shape title="DAG" formats="Nexus" detail="one file, read node by node">
          <g stroke={MESH} strokeWidth={2} fill={panel2}>
            <path d="M134 16 L80 64 M134 16 L188 64 M80 64 L134 112 M188 64 L134 112 M80 64 L50 112 M188 64 L218 112" fill="none" />
            <circle cx={134} cy={16} r={11} />
            <circle cx={80} cy={64} r={11} />
            <circle cx={188} cy={64} r={11} />
            <circle cx={50} cy={112} r={11} />
            <circle cx={134} cy={112} r={11} fill={MESH} />
            <circle cx={218} cy={112} r={11} />
          </g>
        </Shape>
        <Shape title="Paged LOD files" formats="OSGB · 3MX" detail="one file per level, each names its finer files">
          <g stroke={MESH} strokeWidth={2} fill={panel2}>
            <path d="M40 30 h50 l12 12 v58 h-62 Z" />
            <path d="M128 18 h50 l12 12 v58 h-62 Z" />
            <path d="M128 52 h50 l12 12 v58 h-62 Z" />
            <path d="M210 40 h40 M210 80 h40" fill="none" strokeDasharray="5 5" />
            <path d="M102 64 L124 50 M102 70 L124 86" fill="none" />
          </g>
        </Shape>
        <Shape title="Node pages" formats="I3S / SLPK" detail="an always-explicit node tree, paged">
          <g stroke={MESH} strokeWidth={2} fill={panel2}>
            <rect x={30} y={14} width={90} height={104} rx={6} />
            <rect x={148} y={14} width={90} height={104} rx={6} />
            <path d="M46 40 h58 M46 62 h58 M46 84 h40 M164 40 h58 M164 62 h58 M164 84 h40" fill="none" />
          </g>
        </Shape>
        <Shape title="Quadkeys" formats="Bing Maps 3D" detail="availability found by probing">
          <g fill="none" stroke={MESH} strokeWidth={2}>
            <rect x={74} y={4} width={120} height={120} />
            <path d="M134 4 V124 M74 64 H194 M104 4 V64 M74 34 H134" />
          </g>
          <g fill={muted} fontSize={14} fontFamily={mono}>
            <text x={160} y={38}>1</text>
            <text x={98} y={98}>2</text>
            <text x={160} y={98}>3</text>
          </g>
        </Shape>
        <Shape title="Voxel grids × LOD" formats="GeoSplats (MapTiler)" detail="grid_1 / 8 / 64 / 512, 8 LODs">
          <g fill="none" stroke={SPLAT} strokeWidth={2}>
            <rect x={20} y={44} width={60} height={60} />
            <rect x={104} y={44} width={60} height={60} />
            <path d="M134 44 V104 M104 74 H164" />
            <rect x={188} y={44} width={60} height={60} />
            <path d="M203 44 V104 M218 44 V104 M233 44 V104 M188 59 H248 M188 74 H248 M188 89 H248" />
          </g>
        </Shape>
      </div>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 10. geometric error

const ErrCol = ({ title, color, children }: { title: string; color: string; children: ReactNode }) => (
  <div
    style={{
      flex: 1,
      background: panel,
      border: `1px solid ${line}`,
      borderTop: `3px solid ${color}`,
      borderRadius: 'var(--osd-radius)',
      padding: '24px 28px',
      height: 270,
      boxSizing: 'border-box',
    }}
  >
    <div style={{ fontSize: 30, fontWeight: 700 }}>{title}</div>
    <div style={{ fontSize: 26, color: muted, marginTop: 14, lineHeight: 1.5 }}>{children}</div>
  </div>
);

const GeometricError: Page = () => (
  <Frame eyebrow="Hierarchy vs geometry" title="Geometric error decides refinement">
    <div
      style={{
        fontFamily: mono,
        fontSize: 30,
        background: panel2,
        border: `1px solid ${line}`,
        borderRadius: 12,
        padding: '22px 30px',
        color: 'var(--osd-text)',
      }}
    >
      pixels = geometricError × screen height ÷ (2 × distance × tan(fov ÷ 2))
    </div>
    <p style={{ fontSize: 26, color: muted, margin: '18px 0 0' }}>
      No source stores it as such. Each reader derives it, from one of three things:
    </p>
    <div style={{ display: 'flex', gap: 28, marginTop: 26, alignItems: 'stretch' }}>
      <ErrCol title="A value the source stores" color="#22c55e">
        Potree, COPC: point spacing ÷ 2<sup>depth</sup>. Nexus, OSGB, 3MX, Bing 3D: their own errors or ranges.
      </ErrCol>
      <ErrCol title="Density of points or splats" color={PTS}>
        RAD, streamed SOG, a VPC with an overview: box diagonal over the cube root of the count.
      </ErrCol>
      <ErrCol title="The box size alone" color={faint}>
        I3S, LCC, LCC2, GeoSplats by default. <Code color="#e8ecf1">&amp;ge=density</Code> uses counts already in
        the index: no tile downloaded.
      </ErrCol>
    </div>
    <p style={{ fontSize: 26, color: muted, margin: '30px 0 0', lineHeight: 1.45 }}>
      Distance is measured to the bounding volume: a box larger than its content refines whenever the camera is
      inside it. Tight boxes matter as much as the error.
    </p>
  </Frame>
);

// ---------------------------------------------------------------- 11. formats matrix

const Fmt = ({ name, by }: { name: string; by: string }) => (
  <div style={{ padding: '10px 0', borderTop: `1px solid ${line}` }}>
    <div style={{ fontSize: 27, fontWeight: 700, lineHeight: 1.25 }}>{name}</div>
    <div style={{ fontSize: 21, color: muted, lineHeight: 1.3, marginTop: 2 }}>{by}</div>
  </div>
);

const FmtCol = ({ color, title, out, children }: { color: string; title: string; out: string; children: ReactNode }) => (
  <div style={{ flex: 1 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <Dot color={color} size={18} />
      <span style={{ fontSize: 34, fontWeight: 800 }}>{title}</span>
    </div>
    <div style={{ fontFamily: mono, fontSize: 20, color, margin: '8px 0 12px' }}>{out}</div>
    {children}
  </div>
);

const Formats: Page = () => (
  <Frame eyebrow="Formats" title="Which inputs, from whom, to which primitive">
    <div style={{ display: 'flex', gap: 56, marginTop: -8 }}>
      <FmtCol color={PTS} title="Points" out="→ glTF POINTS (+ LAS attributes)">
        <Fmt name="COPC" by="Hobu · copc.io, LAZ chunks" />
        <Fmt name="Potree 1.x and 2.0" by="PotreeConverter octrees" />
        <Fmt name="VPC" by="PDAL · QGIS virtual point clouds" />
        <Fmt name="I3S point layers" by="Esri, LEPCC codec" />
        <Fmt name="LAS / LAZ, raw" by="tiled first by PDAL, PotreeConverter…" />
      </FmtCol>
      <FmtCol color={MESH} title="Meshes" out="→ glTF TRIANGLES + textures">
        <Fmt name="I3S / SLPK" by="Esri, OGC community standard" />
        <Fmt name="3MX" by="Bentley ContextCapture (Acute3D)" />
        <Fmt name="OSGB" by="OpenSceneGraph: ContextCapture, DJI Terra" />
        <Fmt name="Nexus .nxs / .nxz" by="CNR-ISTI Visual Computing Lab, 3DHOP" />
        <Fmt name="Bing Maps 3D" by="Microsoft, undocumented" />
        <Fmt name="Google Photorealistic" by="loaded directly by the viewer" />
      </FmtCol>
      <FmtCol color={SPLAT} title="Gaussian splats" out="→ KHR_gaussian_splatting + SPZ v2">
        <Fmt name="Streamed SOG" by="PlayCanvas · SuperSplat" />
        <Fmt name="LCC" by="XGRIDS" />
        <Fmt name="LCC2" by="XGRIDS, its 2026 successor" />
        <Fmt name="RAD" by="SparkJS" />
        <Fmt name="GeoSplats" by="MapTiler" />
      </FmtCol>
    </div>
    <div
      style={{
        marginTop: 22,
        fontSize: 25,
        color: muted,
        background: panel,
        border: `1px solid ${line}`,
        borderRadius: 12,
        padding: '16px 26px',
      }}
    >
      <span style={{ color: 'var(--osd-text)', fontWeight: 700 }}>Already 3D Tiles:</span> .3tz and .3dtiles
      packages served in place · implicit → explicit · b3dm, pnts, glTF 1.0 → 3D Tiles 1.1
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 12. meta-tilesets

const Step = ({ n, title, children }: { n: string; title: string; children: ReactNode }) => (
  <div style={{ display: 'flex', gap: 20 }}>
    <span style={{ fontFamily: mono, fontSize: 26, color: 'var(--osd-accent)', width: 30, flex: 'none' }}>{n}</span>
    <div>
      <div style={{ fontSize: 28, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 23, color: muted, lineHeight: 1.4, marginTop: 2 }}>{children}</div>
    </div>
  </div>
);

const MetaTilesets: Page = () => (
  <Frame eyebrow="Aggregate" title="Meta-tilesets: hundreds of datasets, one URL">
    <div style={{ display: 'flex', gap: 60 }}>
      <svg width={960} height={540} viewBox="0 0 960 540">
        <ArrowDefs />
        <rect x={300} y={6} width={360} height={64} rx={12} fill={panel} stroke="#22c55e" strokeWidth={2} />
        <text x={480} y={46} fontSize={22} fill="#e8ecf1" textAnchor="middle" fontFamily={mono}>
          /aggregate/tileset.json
        </text>
        <path d="M480 70 L170 160 M480 70 L480 160 M480 70 L790 160" stroke={line} strokeWidth={2} />
        <rect x={80} y={160} width={180} height={52} rx={10} fill={panel2} stroke={line} />
        <text x={170} y={193} fontSize={20} fill={muted} textAnchor="middle" fontFamily={mono}>
          cell 0·2
        </text>
        <rect x={390} y={160} width={180} height={52} rx={10} fill={panel2} stroke={line} />
        <text x={480} y={193} fontSize={20} fill={muted} textAnchor="middle" fontFamily={mono}>
          cell 1·3·0
        </text>
        <rect x={700} y={160} width={180} height={52} rx={10} fill={panel2} stroke={line} />
        <text x={790} y={193} fontSize={20} fill={muted} textAnchor="middle" fontFamily={mono}>
          cell 3·1
        </text>
        <path d="M170 212 L70 300 M170 212 L190 300 M480 212 L330 300 M480 212 L470 300 M480 212 L610 300 M790 212 L750 300 M790 212 L890 300" stroke={line} strokeWidth={2} />
        <circle cx={70} cy={320} r={20} fill={PTS} />
        <circle cx={190} cy={320} r={20} fill={MESH} />
        <circle cx={330} cy={320} r={20} fill={PTS} />
        <circle cx={470} cy={320} r={20} fill={MESH} />
        <circle cx={610} cy={320} r={20} fill={SPLAT} />
        <circle cx={750} cy={320} r={20} fill={MESH} />
        <circle cx={890} cy={320} r={20} fill={PTS} />
        <path d="M70 340 L70 400 M190 340 L190 400 M330 340 L330 400 M470 340 L470 400 M610 340 L610 400 M750 340 L750 400 M890 340 L890 400" stroke={faint} strokeWidth={2} strokeDasharray="5 6" />
        <text x={480} y={432} fontSize={23} fill="#e8ecf1" textAnchor="middle">
          each leaf: content.uri → the dataset&apos;s own tileset.json, refine ADD
        </text>
        <text x={480} y={466} fontSize={22} fill={muted} textAnchor="middle">
          a Potree or COPC dataset is wrapped through /stream first
        </text>
        <text x={480} y={500} fontSize={22} fill={muted} textAnchor="middle">
          tile metadata per leaf: id, name, project, date, format, licence
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, flex: 1 }}>
        <Step n="1" title="Select">?set=, ?url=, ?vpc=; filter by format, date, latest</Step>
        <Step n="2" title="Read each child root">16 at a time, cached a day; no content opened</Step>
        <Step n="3" title="Group">flat, mercator or geodetic quadtree, path-compressed</Step>
        <Step n="4" title="Bound">spheres or regions; error 2× the largest child</Step>
        <Step n="5" title="Emit">an explicit 3D Tiles 1.1 tileset, cached</Step>
      </div>
    </div>
    <div style={{ display: 'flex', gap: 60, marginTop: 6, borderTop: `1px solid ${line}`, paddingTop: 22 }}>
      <Stat value="16 ms">to build the tree of 692 datasets; 10.8 s cold is fetching their roots</Stat>
      <Stat value="65 KB">the gzipped index of 710 datasets (413 KB raw)</Stat>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 13. sets and builder

const Sets: Page = () => (
  <Frame eyebrow="Aggregate" title="Sets you name, upload, or build by hand">
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
      <Card title="Named sets" accent="#22c55e" style={{ height: 200 }}>
        <Code color="#e8ecf1">?set=open · flai · aerometrex · vexcel…</Code> from the server&apos;s sets folder.
        With <Code color="#e8ecf1">&quot;unlisted&quot;: true</Code> a set opens by name only, never listed.
      </Card>
      <Card title="Uploaded manifests" accent="#22c55e" style={{ height: 200 }}>
        <Code color="#e8ecf1">POST /aggregate/set</Code> → <Code color="#e8ecf1">set=upload-…</Code>. Kept a week
        after last use, across restarts; up to 50.
      </Card>
      <Card title="A VPC is a manifest" accent={PTS} style={{ height: 200 }}>
        <Code color="#e8ecf1">?vpc=&lt;url&gt;</Code>: a PDAL / QGIS virtual point cloud as the set; VPCs may nest,
        one per country.
      </Card>
      <Card title="Aggregate Builder" accent={MESH} style={{ height: 200 }}>
        <Code color="#e8ecf1">/builder</Code>: your own groups (site, campaign, year), metadata per node; export a
        tileset.json or a set manifest.
      </Card>
    </div>
    <div
      style={{
        marginTop: 34,
        fontFamily: mono,
        fontSize: 25,
        color: muted,
        lineHeight: 1.7,
        background: panel2,
        border: `1px solid ${line}`,
        borderRadius: 12,
        padding: '18px 28px',
      }}
    >
      <div>
        <span style={{ color: 'var(--osd-text)' }}>/aggregate/</span>tileset.json · index.json ·{' '}
        <span style={{ color: 'var(--osd-accent)' }}>index.geojson</span> · snap.ndjson
      </div>
      <div>&amp;nest=geodetic &amp;bv=region &amp;snap=1 &amp;format=copc &amp;latest=1 &amp;cut=auto</div>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 14. viewer

const Viewer: Page = () => (
  <Frame eyebrow="Clients" title="The web viewer: CesiumJS and 3DTilesRendererJS">
    <div style={{ display: 'flex', gap: 54 }}>
      <Shot
        src={viewerOsgb}
        w={1100}
        h={619}
        caption="demo.3dtiled.iconem.com: Weinan (ContextCapture OSGB) streamed live. Captured 2026-11-25."
      />
      <ul style={{ margin: 0, paddingLeft: 30, fontSize: 29, lineHeight: 1.55, color: 'var(--osd-text)' }}>
        <li>Two renderers, one view</li>
        <li>A pill per format: live presets</li>
        <li>
          <Code>cache=</Code> and <Code>transform=</Code> on top
        </li>
        <li>Crop and extract a box</li>
        <li style={{ listStyle: 'none', color: muted, fontSize: 24, marginLeft: -2 }}>LAS · COPC · GLB · SPZ · SOG · PLY</li>
        <li>Hierarchy explorer</li>
        <li>Potree lab, builder</li>
        <li>Terrain, snap to ground</li>
        <li>Google 3D on two globes</li>
      </ul>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 15–16. desktop

const DesktopTabs: Page = () => (
  <Frame eyebrow="Clients" title="The desktop app: the middleware on your machine">
    <p style={{ fontSize: 28, color: muted, margin: '-18px 0 0' }}>
      Electrobun, Windows · macOS · Linux. It runs the tile-server locally; nothing is uploaded.
    </p>
    <div style={{ display: 'flex', gap: 60, marginTop: 30 }}>
      <Shot src={desktopStream} w={487} h={560} caption={<><b style={{ color: '#e8ecf1' }}>Stream live</b>: a URL to paste into any client</>} />
      <Shot src={desktopExport} w={487} h={560} caption={<><b style={{ color: '#e8ecf1' }}>Export</b>: a finished, static 3D Tiles folder</>} />
      <Shot src={desktopTile} w={487} h={560} caption={<><b style={{ color: '#e8ecf1' }}>Tile raw input</b>: 21 tilers, PDAL to Obj2Tiles</>} />
    </div>
  </Frame>
);

const DesktopLibrary: Page = () => (
  <Frame eyebrow="Clients" title="Library and Streams">
    <div style={{ display: 'flex', gap: 60 }}>
      <Shot
        src={desktopLibrary}
        w={487}
        h={600}
        caption={<><b style={{ color: '#e8ecf1' }}>Library</b>: bookmarks, history, samples</>}
      />
      <div style={{ flex: 1 }}>
        <Shot
          src={desktopStreams}
          w={760}
          h={312}
          caption={<><b style={{ color: '#e8ecf1' }}>Streams</b> with its status pills: one URL answers, one does not</>}
        />
        <ul style={{ margin: '30px 0 0', paddingLeft: 30, fontSize: 28, lineHeight: 1.6, color: muted }}>
          <li>Every URL you add, copy or preview gets a row</li>
          <li>Rename, reorder, pause, load back into the form</li>
          <li>Kept across restarts, like the Library</li>
        </ul>
      </div>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 17. ecosystem

const PR = ({ n, state, children }: { n: string; state: 'merged' | 'open'; children: ReactNode }) => (
  <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', fontSize: 24, lineHeight: 1.4 }}>
    <span style={{ fontFamily: mono, color: 'var(--osd-text)', width: 76, flex: 'none' }}>{n}</span>
    <span style={{ color: muted, flex: 1 }}>{children}</span>
    <span
      style={{
        fontSize: 19,
        padding: '2px 10px',
        borderRadius: 999,
        border: `1px solid ${state === 'merged' ? '#22c55e' : faint}`,
        color: state === 'merged' ? '#22c55e' : muted,
        flex: 'none',
      }}
    >
      {state}
    </span>
  </div>
);

const Ecosystem: Page = () => (
  <Frame eyebrow="Ecosystem" title="Around 3dtiled">
    <div style={{ display: 'flex', gap: 28 }}>
      <Card title="blender_ogc3dtiles" accent={MESH} style={{ width: 500, height: 400 }}>
        Stream OGC 3D Tiles into Blender with cesium-native: meshes, point clouds, Gaussian splats, voxels,
        raster overlays, clipping. MIT.
      </Card>
      <Card title="terrain-viewer" accent={PTS} style={{ width: 500, height: 400 }}>
        Compare global terrain sources (TerrainRGB, Terrarium, COG DEMs) with hillshade, contours and hypsometry
        on MapLibre. MIT.
      </Card>
      <div
        style={{
          flex: 1,
          background: panel,
          border: `1px solid ${line}`,
          borderTop: '3px solid #22c55e',
          borderRadius: 'var(--osd-radius)',
          padding: '26px 30px',
          boxSizing: 'border-box',
          height: 400,
        }}
      >
        <div style={{ fontSize: 32, fontWeight: 700 }}>Upstream</div>
        <div style={{ fontSize: 22, color: faint, margin: '10px 0 12px' }}>NASA-AMMOS/3DTilesRendererJS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <PR n="#1780" state="merged">point-cloud fixes</PR>
          <PR n="#1782" state="merged">additive traversal skip</PR>
          <PR n="#1792" state="open">adaptive point size, ADD octrees</PR>
        </div>
        <div style={{ fontSize: 22, color: faint, margin: '16px 0 10px' }}>donmccurdy/glTF-Transform</div>
        <PR n="#1877" state="open">writer: GLB write 88 → 13 ms</PR>
      </div>
    </div>
    <div style={{ display: 'flex', gap: 60, marginTop: 44, fontSize: 27, color: muted, lineHeight: 1.5 }}>
      <div style={{ flex: 1 }}>
        <span style={{ color: 'var(--osd-text)', fontWeight: 700 }}>These two and 3dtiled</span> live under{' '}
        <Code color="#e8ecf1">github.com/jo-chemla</Code>, each with an Iconem fork.
      </div>
      <div style={{ flex: 1 }}>
        <span style={{ color: 'var(--osd-text)', fontWeight: 700 }}>jo-chemla/3dtiles-samples</span>: public
        reproducers on GitHub Pages, behind the upstream issues.
      </div>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 18. roadmap

const Next = ({ title, status, children }: { title: string; status: string; children: ReactNode }) => (
  <div
    style={{
      background: panel,
      border: `1px solid ${line}`,
      borderRadius: 'var(--osd-radius)',
      padding: '24px 28px',
      height: 270,
      boxSizing: 'border-box',
    }}
  >
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16 }}>
      <span style={{ fontSize: 30, fontWeight: 700 }}>{title}</span>
      <span style={{ fontSize: 20, color: faint, fontFamily: mono, whiteSpace: 'nowrap' }}>{status}</span>
    </div>
    <div style={{ fontSize: 25, color: muted, lineHeight: 1.5, marginTop: 14 }}>{children}</div>
  </div>
);

const Roadmap: Page = () => (
  <Frame eyebrow="Roadmap" title="Next steps">
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 28 }}>
      <Next title="Formats in the browser" status="plan">
        3DTilesRendererJS plugins for COPC and VPC, then Nexus, 3MX, I3S and OSGB, reusing the readers: no tile
        server.
      </Next>
      <Next title="Fastest point tiler" status="research">
        Raw points to COPC and 3D Tiles with PotreeConverter 2.0&apos;s out-of-core chunking; benchmark first.
      </Next>
      <Next title="Streaming architecture" status="design">
        <Code>tiling=explicit</Code> through implicit-to-explicit; a progress endpoint for hierarchy and full jobs.
      </Next>
      <Next title="Spec direction" status="watch">
        3D Tiles 2.0 on glTF 2.1 extensions; meshopt for points, which <Code>transform=meshopt</Code> already
        emits.
      </Next>
      <Next title="Look and accuracy" status="to check">
        Compare splat presets by eye after the renderer upgrade; check errors against each format&apos;s own
        viewer.
      </Next>
      <Next title="Ship" status="open">
        Signed desktop builds (macOS Developer ID, Windows); drop vendored upstream patches once released.
      </Next>
    </div>
  </Frame>
);

// ---------------------------------------------------------------- 19. closing

const LinkRow = ({ url, what }: { url: string; what: string }) => (
  <div style={{ display: 'flex', gap: 40, alignItems: 'baseline', padding: '14px 0', borderTop: `1px solid ${line}` }}>
    <span style={{ fontFamily: mono, fontSize: 34, color: 'var(--osd-text)', width: 860 }}>{url}</span>
    <span style={{ fontSize: 28, color: muted }}>{what}</span>
  </div>
);

const Closing: Page = () => (
  <div style={{ ...fill, padding: '120px 160px 0' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
      <img src={logo} width={96} height={96} alt="" />
      <span style={{ fontSize: 110, fontWeight: 900, letterSpacing: '-0.03em' }}>3dtiled</span>
    </div>
    <div style={{ marginTop: 70 }}>
      <LinkRow url="docs.3dtiled.iconem.com" what="documentation" />
      <LinkRow url="demo.3dtiled.iconem.com" what="web viewer" />
      <LinkRow url="3dtiled.iconem.com" what="middleware and API" />
      <LinkRow url="github.com/jo-chemla/3dtiled-to-3dtiles" what="source, MIT" />
    </div>
    <div style={{ marginTop: 60, fontFamily: mono, fontSize: 30, color: muted }}>
      docker compose up --build <span style={{ color: faint, margin: '0 24px' }}>or</span> pnpm install &amp;&amp; pnpm dev
    </div>
    <Footer />
  </div>
);

export const meta: SlideMeta = {
  title: '3dtiled',
  createdAt: '2026-11-25T18:34:19.687Z',
};

export default [
  Cover,
  WhatItIs,
  Genesis,
  Idea,
  PushPull,
  CacheModes,
  RangeReads,
  HierarchyGeometry,
  Shapes,
  GeometricError,
  Formats,
  MetaTilesets,
  Sets,
  Viewer,
  DesktopTabs,
  DesktopLibrary,
  Ecosystem,
  Roadmap,
  Closing,
] satisfies Page[];

export const notes: (string | undefined)[] = [
  'Open source, MIT. One sentence: tiled 3D formats in, OGC 3D Tiles out, converted when a client asks.',
  'Three parts: offline converters, the live tile-server, and the clients. The server is the centre.',
  'Dates from CHANGELOG.md. Started 2026-06-18; the live COPC server came four days later.',
  'The unifying idea: map the source tree, do not rebuild it. TiTiler for COG is the analogy.',
  'Push walks everything; pull answers one request at a time. /export bridges the two.',
  'cache=none is the default. cache=full is /convert. Same code path either way.',
  'Every source read goes through one layer (core/source-fetch.js) with these rules, tested per format.',
  'Hierarchy and geometry are two separate jobs: the tree is read lazily, a node is decoded on request.',
  'Ten shapes of source hierarchy, all mapped onto implicit or explicit 3D Tiles trees.',
  'See the docs page "Geometric error, format by format" for the line of code behind each rule.',
  'Derived from supported-formats.mdx. Colours: amber points, blue meshes, violet splats.',
  'A mosaic only reads each child root; clients stream tiles from each source directly.',
  'Uploads are never listed; the set name is a hash of the entries.',
  'Public demo; any preset loads live through 3dtiled.iconem.com.',
  'Desktop screenshots come from the docs (taken 2026-11-18, dark theme).',
  'The Streams list is new (2026-11-24); each row says whether its URL answers a tileset.',
  'Upstream PR states checked on 2026-11-25.',
  'From the TODO / future work page and the planning pages.',
  undefined,
];
