// Minimal types for the vendored, untyped PotreePlugin.js (used from TS by lib/nativeLeaves.ts).
export class PotreePlugin {
  constructor(options?: { url?: string | null; pointScale?: number; useRecommendedSettings?: boolean; [k: string]: unknown });
  name: string;
  pointScale: number;
  [k: string]: any;
}
