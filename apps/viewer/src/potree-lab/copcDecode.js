/**
 * One COPC chunk (LAZ, point formats 6 to 8) → the arrays of a geometry, packed in ONE ArrayBuffer:
 * it crosses from the worker as a single transfer, it is what the renderer's parse step is handed (an
 * ArrayBuffer whose first four bytes are a magic), and the attributes are views on it. No three.js
 * here: the same code runs in ./copcWorker.js and, without a worker, on the page.
 *
 * Layout (little endian): 'CPCD', uint32 count, uint32 flags (bit 0: colour width known, bit 1:
 * 16-bit colours, bits 8-15: attribute mask), float64 GPS time base, float64 × 3 centre, then the
 * arrays of FIELDS in order (the optional ones when their bit is in the mask).
 */
import { createLazPerf } from 'laz-perf';
import lazPerfWasm from 'laz-perf/lib/web/laz-perf.wasm?url';

const MAGIC = 0x44435043; // 'CPCD'
export const HEADER_BYTES = 48;

// Largest elements first, so every array is aligned. `read` takes the LAS record (formats 6 to 8).
const FIELDS = [
	{ name: 'position', type: Float32Array, size: 3 },
	{ name: 'gpsTime', bit: 64, type: Float32Array, size: 1 },
	{ name: 'color', type: Uint16Array, size: 3 },
	{ name: 'intensity', bit: 1, type: Uint16Array, size: 1, read: ( v, p ) => v.getUint16( p + 12, true ) },
	{ name: 'pointSourceId', bit: 16, type: Uint16Array, size: 1, read: ( v, p ) => v.getUint16( p + 20, true ) },
	{ name: 'classification', bit: 2, type: Uint8Array, size: 1, read: ( v, p ) => v.getUint8( p + 16 ) },
	{ name: 'returnNumber', bit: 4, type: Uint8Array, size: 1, read: ( v, p ) => v.getUint8( p + 14 ) & 15 },
	{ name: 'numberOfReturns', bit: 8, type: Uint8Array, size: 1, read: ( v, p ) => v.getUint8( p + 14 ) >> 4 },
	{ name: 'userData', bit: 32, type: Uint8Array, size: 1, read: ( v, p ) => v.getUint8( p + 17 ) },
];

/** The attributes read beside position and colour, as bits of a mask. */
export const ATTR = Object.fromEntries( FIELDS.filter( f => f.bit ).map( f => [ f.name, f.bit ] ) );
export const ATTR_ALL = 127;

/** `[ 'intensity', 'classification' ]` → mask. Unknown names are ignored. */
export function attributeMask( names ) {

	return names.reduce( ( mask, n ) => mask | ( ATTR[ n ] || 0 ), 0 );

}

// sRGB byte → linear, as a normalized uint16 (what three expects of a vertex colour)
const SRGB_TO_LINEAR16 = new Uint16Array( 256 ).map( ( _, i ) => {

	const c = i / 255;
	return Math.round( ( c <= 0.04045 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4 ) * 65535 );

} );

/** laz-perf (wasm). The web build also runs in a worker once it is told where its wasm is. */
export function loadLazPerf() {

	return createLazPerf( { locateFile: () => lazPerfWasm } );

}

// The arrays of `n` points with the attributes of `mask`, as views on `buffer` (or only the byte
// length, without a buffer).
function views( buffer, n, mask ) {

	const out = {};
	let offset = HEADER_BYTES;
	for ( const { name, bit, type, size } of FIELDS ) {

		if ( bit && ! ( mask & bit ) ) continue;
		if ( buffer ) out[ name ] = new type( buffer, offset, size * n );
		offset += type.BYTES_PER_ELEMENT * size * n;

	}

	out.byteLength = offset;
	return out;

}

/** Typed-array views on a packed buffer, and what its header says. */
export function unpack( buffer ) {

	const head = new DataView( buffer, 0, HEADER_BYTES );
	if ( head.getUint32( 0, true ) !== MAGIC ) throw new Error( 'COPC: not a decoded chunk' );

	const count = head.getUint32( 4, true );
	const flags = head.getUint32( 8, true );
	const mask = ( flags >> 8 ) & 0xff;
	return {
		...views( buffer, count, mask ),
		count,
		mask,
		wide: flags & 1 ? Boolean( flags & 2 ) : null,
		gpsBase: head.getFloat64( 16, true ),
		center: [ 0, 1, 2 ].map( i => head.getFloat64( 24 + 8 * i, true ) ),
	};

}

/**
 * Decompress one chunk and write its arrays. `job`: { pointCount, format, recordLength, scale, offset,
 * center, mask, wide (true, false, or null: find out), gpsBase (a number, or null: the first point's
 * time) }. Each record is read where laz-perf leaves it in the wasm heap.
 */
export function decodeChunk( LazPerf, compressed, job ) {

	const { pointCount: n, format, recordLength, scale, offset, center, mask } = job;
	const buffer = new ArrayBuffer( views( null, n, mask ).byteLength );
	const out = views( buffer, n, mask );
	const { position, color, gpsTime } = out;
	const fields = FIELDS.filter( f => f.read && out[ f.name ] ).map( f => [ out[ f.name ], f.read ] );
	const hasRgb = format >= 7; // formats 7 and 8: red, green, blue at byte 30
	let gpsBase = job.gpsBase ?? null;
	let maxRgb = 0;

	if ( n ) {

		const blob = LazPerf._malloc( compressed.byteLength );
		const p = LazPerf._malloc( recordLength );
		const decoder = new LazPerf.ChunkDecoder();
		try {

			LazPerf.HEAPU8.set( compressed, blob );
			decoder.open( format, recordLength, blob );
			let v = new DataView( LazPerf.HEAPU8.buffer );
			for ( let i = 0; i < n; i ++ ) {

				decoder.getPoint( p );
				if ( v.buffer !== LazPerf.HEAPU8.buffer ) v = new DataView( LazPerf.HEAPU8.buffer ); // the heap grew

				// no colour in the file: its intensity as a grey (the top byte, or the value when it fits one)
				const grey = hasRgb ? 0 : SRGB_TO_LINEAR16[ v.getUint8( p + 13 ) || v.getUint8( p + 12 ) ];
				for ( let a = 0; a < 3; a ++ ) {

					position[ i * 3 + a ] = v.getInt32( p + 4 * a, true ) * scale[ a ] + offset[ a ] - center[ a ];
					const c = hasRgb ? v.getUint16( p + 30 + 2 * a, true ) : grey;
					color[ i * 3 + a ] = c;
					if ( hasRgb && c > maxRgb ) maxRgb = c;

				}

				for ( const [ array, read ] of fields ) array[ i ] = read( v, p );
				if ( gpsTime ) {

					const t = v.getFloat64( p + 22, true );
					gpsBase ??= t;
					gpsTime[ i ] = t - gpsBase;

				}

			}

		} finally {

			LazPerf._free( blob );
			LazPerf._free( p );
			decoder.delete();

		}

	}

	// RGB is 16 bits by the specification, but many files store 8-bit values as they are: the first
	// chunk with points decides for the file (a value above 255 means 16 bits)
	let wide = job.wide ?? null;
	if ( hasRgb && n ) {

		wide ??= maxRgb > 255;
		const shift = wide ? 8 : 0;
		for ( let i = 0; i < color.length; i ++ ) color[ i ] = SRGB_TO_LINEAR16[ Math.min( 255, color[ i ] >> shift ) ];

	}

	const head = new DataView( buffer, 0, HEADER_BYTES );
	head.setUint32( 0, MAGIC, true );
	head.setUint32( 4, n, true );
	head.setUint32( 8, ( wide === null ? 0 : 1 ) | ( wide ? 2 : 0 ) | ( mask << 8 ), true );
	head.setFloat64( 16, gpsBase ?? 0, true );
	center.forEach( ( c, i ) => head.setFloat64( 24 + 8 * i, c, true ) );
	return buffer;

}
