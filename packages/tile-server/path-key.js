/**
 * A file path inside a dataset as one path segment of a tile URL (`/stream/tile/<key>.glb`, `/stream/osgb/node/<key>.json`).
 * `encodeURIComponent` alone writes a slash as `%2F`, which the reverse proxy in front of the production server refuses
 * with a bare 400 (seen 2026-11-13 on every OSGB and 3MX tile; the same URL with plain slashes passed). A slash is
 * written as `~` instead, a literal `~` as `%7E`.
 */
export const pathKey = (rel) => encodeURIComponent(rel).replace(/~/g, '%7E').replace(/%2F/gi, '~');
export const pathOfKey = (key) => decodeURIComponent(key.replace(/~/g, '%2F'));
