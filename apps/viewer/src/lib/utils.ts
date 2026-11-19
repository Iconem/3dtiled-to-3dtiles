import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The error target (px) a tileset is given when none is set: 16 for meshes, 2 for point clouds, 0.5 for splats, whose
 * tilesets state an error far above what a tile really lacks. A streamed SOG is the exception: its tiles' errors are
 * 8 × the spacing of their splats (sog-to-3dtiles lodMeta.js), so at 8 px a tile refines when its splats stand a
 * pixel apart; at 0.5 px it loaded its finest level, millions of splats, as soon as it was on screen.
 */
export function defaultSseFor(type: string | undefined, url: string | undefined): number {
  if (type === 'splat') return /[?&]format=sog(&|$)/.test(url ?? '') ? 8 : 0.5;
  return type === 'mesh' ? 16 : 2;
}
