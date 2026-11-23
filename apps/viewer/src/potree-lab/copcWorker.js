/**
 * Worker of CopcLoader (./copcPlugin.js): { id, compressed, job } in, { id, buffer, decodeMs } or
 * { id, error } out, the packed buffer of ./copcDecode.js transferred back.
 */
import { decodeChunk, loadLazPerf } from './copcDecode.js';

let lazPerf = null;

self.onmessage = async ( { data: { id, compressed, job } } ) => {

	try {

		lazPerf ??= loadLazPerf();
		const LazPerf = await lazPerf;
		const t0 = performance.now();
		const buffer = decodeChunk( LazPerf, compressed, job );
		self.postMessage( { id, buffer, decodeMs: performance.now() - t0 }, [ buffer ] );

	} catch ( e ) {

		self.postMessage( { id, error: String( e?.message ?? e ) } );

	}

};
