// Types of extract-core.js for the viewer (the server imports the .js as it is).
export type Bbox = [number, number, number, number, number, number];   // west°, south°, minH, east°, north°, maxH

export interface ExtractDeps {
  fetchBytes: (url: string) => Promise<Uint8Array>;
  readGlb?: (bytes: Uint8Array) => Promise<unknown>;
  Document?: unknown;
  onTexture?: (out: unknown, mimeType: string) => void;
  splat?: unknown;
  splatPool?: unknown;
  warn?: (message: string) => void;
}
export interface ExtractOptions {
  url: string;
  bb: number[];
  maxGE?: number;
  maxDepth?: number;
  initM?: number[];
  deps: ExtractDeps;
  signal?: AbortSignal;
  onProgress?: (p: Record<string, number | string>) => void;
  onSkip?: (tileUrl: string, error: unknown) => void;
}
export interface ExtractSink {
  write: (bytes: Uint8Array) => Promise<void> | void;
  rewrite?: (position: number, bytes: Uint8Array) => Promise<void> | void;
}

export const IDENT: number[];
export const SPLAT_FORMATS: string[];
export function parseBbox(str: unknown): number[] | null;
export function walkTileset(
  tilesetUrl: string, bb: number[],
  o: { maxGE?: number; maxDepth?: number; initM?: number[]; fetchBytes: (url: string) => Promise<Uint8Array>; signal?: AbortSignal },
  onContent: (tileUrl: string, worldM: number[], node: unknown) => Promise<void> | void,
): Promise<void>;
export function extractTilesetJson(o: ExtractOptions): Promise<{ tileset: unknown; tiles: number }>;
export function extractZip(o: ExtractOptions, sink: ExtractSink): Promise<{ tiles: number; bytes: number }>;
export function extractLas(
  o: ExtractOptions & { enu?: boolean; twoPass?: boolean; onCounted?: (c: { points: number }) => void | Promise<void> },
  sink: ExtractSink,
): Promise<{ points: number; tiles: number; bbox: { min: number[]; max: number[] } | null }>;
export function extractMeshDocument(o: ExtractOptions): Promise<{ document: unknown; primitives: number; tiles: number }>;
export function extractSplats(
  o: ExtractOptions & { format?: string | null; clip?: boolean; rx?: string | null },
): Promise<{ bytes: Uint8Array; name: string; tiles: number; splats: number; raw: number; clipped: number } | null>;
export function crc32(bytes: Uint8Array): number;
