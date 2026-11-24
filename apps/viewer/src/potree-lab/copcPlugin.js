/**
 * CopcPlugin — a COPC (.copc.laz) read straight from its bucket by 3DTilesRendererJS, with no tile
 * server: range requests for the header, the hierarchy pages and each node's LAZ chunk.
 *
 * A COPC octree has the shape of a Potree one (a cube halved per level, additive refinement, a point
 * spacing halved per level), so this is upstream's PotreePlugin with another loader: the tiles, the
 * geometric error, the adaptive point size and eye-dome lighting are its own. A node keeps Potree's
 * name (`r` + one octant digit per level, bit 2 = x, bit 1 = y, bit 0 = z), translated to COPC's
 * `level-x-y-z` at the loader.
 *
 * The loader: copc.js reads the header, the info VLR, the WKT and the root hierarchy page; a deeper
 * page is read when the first node under it is asked for; a node's chunk is one range request through
 * the renderer's plugins, decoded in a small pool of workers (./copcWorker.js, ./copcDecode.js), on
 * the page when no worker starts. Beside `position` and `color` the geometry has `intensity`,
 * `classification`, `returnNumber`, `numberOfReturns`, `pointSourceId`, `userData` and `gpsTime`.
 *
 * `placement: 'globe'` gives the root tile a transform to earth-centred coordinates from the file's
 * CRS (./copcPlacement.js); `plugin.placement` says what was done, or why not.
 *
 * Phase 0 of docs/guide/planning/tiled-formats-plugin: it lives in the Potree lab, not in a package.
 * Not done: a VPC, a geoid, the bending of a country-wide cloud onto the ellipsoid.
 */
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { Copc } from 'copc';
import { PotreePlugin } from '3d-tiles-renderer/plugins';
import { ATTR, ATTR_ALL, attributeMask, decodeChunk, loadLazPerf, unpack } from './copcDecode.js';
import { placementFromCrs } from './copcPlacement.js';

/** `r` + octant digits → COPC `level-x-y-z`. */
export function copcKey( key ) {

	const xyz = [ 0, 0, 0 ];
	for ( let i = 1; i < key.length; i ++ ) {

		const o = key.charCodeAt( i ) - 48;
		for ( let a = 0; a < 3; a ++ ) xyz[ a ] = xyz[ a ] * 2 + ( ( o >> ( 2 - a ) ) & 1 );

	}

	return `${ key.length - 1 }-${ xyz.join( '-' ) }`;

}

/** The default number of decode workers: one core is left to the page, four are enough for 25 downloads. */
export function defaultWorkerCount() {

	return Math.max( 1, Math.min( 4, ( globalThis.navigator?.hardwareConcurrency ?? 2 ) - 1 ) );

}

/** The surface PotreePlugin expects of its loader, over a COPC file. */
export class CopcLoader {

	/**
	 * @param {Object} [options]
	 * @param {number} [options.workers]  Decode workers; 0 decodes on the page. Default: min(4, cores − 1).
	 * @param {string[]} [options.attributes]  Attributes read beside position and colour. Default: all of ATTR.
	 */
	constructor( options = {} ) {

		this.fetchOptions = {};
		this.fetchData = ( url, options ) => fetch( url, options );
		this.metadata = null;
		this.copc = null;
		this.url = null;
		this.nodes = new Map(); // COPC key → { pointCount, pointDataOffset, pointDataLength }
		this.pendingPages = new Map(); // COPC key of a page's first node → { pageOffset, pageLength }
		this._pageLoads = new Map(); // the same key → the read in flight
		this._wide = null; // colours on 16 bits, or 8 bits stored in 16; null until seen
		this._gpsBase = 0;
		this._mask = options.attributes ? attributeMask( options.attributes ) : ATTR_ALL;
		this._wanted = options.workers ?? defaultWorkerCount();
		this._workers = []; // { worker, busy }
		this._jobs = new Map(); // job id → { resolve, reject, entry, compressed, job }
		this._jobId = 0;
		this._lazPerf = null; // laz-perf on the page, made only when a chunk has to be decoded here
		this.workerNote = ''; // why decoding runs on the page, when it does

		// decodeMs: time in the decoder, wherever it ran; mainMs: the part that held the page
		this.stats = { requests: 0, retries: 0, bytes: 0, pages: 0, decodeMs: 0, mainMs: 0, points: 0, workerChunks: 0, mainChunks: 0 };

		// PotreePlugin reads `hierarchy.get( key ).childMask`: answered from what is known now, so that a
		// page read later shows up without anything to rebuild.
		this.hierarchy = {
			has: key => this.nodes.has( copcKey( key ) ),
			get: key => {

				const node = this.nodes.get( copcKey( key ) );
				if ( ! node ) return undefined;

				let childMask = 0;
				for ( let o = 0; o < 8; o ++ ) {

					const child = copcKey( key + o );
					if ( this.nodes.has( child ) || this.pendingPages.has( child ) ) childMask |= 1 << o;

				}

				return { childMask, numPoints: node.pointCount };

			},
		};

	}

	/** Workers alive now (0: decoding on the page). */
	get workerCount() {

		return this._workers.length;

	}

	// A range of the file, through the renderer's plugins (auth, URL rewriting) like any tile, with one
	// more try on a network failure (seen from S3 under 25 parallel ranges).
	_getter( signal ) {

		return async ( begin, end ) => {

			const init = { ...this.fetchOptions, signal, headers: { ...this.fetchOptions?.headers, Range: `bytes=${ begin }-${ end - 1 }` } };
			const res = await this.fetchData( this.url, init ).catch( async e => {

				if ( signal?.aborted || e?.name === 'AbortError' ) throw e;
				await new Promise( r => setTimeout( r, 300 ) );
				this.stats.retries ++;
				return this.fetchData( this.url, init );

			} );

			if ( ! res.ok ) throw new Error( `COPC: HTTP ${ res.status } on bytes ${ begin }-${ end - 1 }` );

			// a server that ignores Range answers 200 with the whole file: refuse it before reading it, not after 10 GB
			if ( res.status === 200 && ! ( Number( res.headers.get( 'content-length' ) ) <= end ) ) {

				await res.body?.cancel().catch( () => {} );
				throw new Error( 'COPC: the server ignores the Range header and sends the whole file: refused' );

			}

			const bytes = new Uint8Array( await res.arrayBuffer() );
			this.stats.requests ++;
			this.stats.bytes += bytes.length;
			return res.status === 200 ? bytes.subarray( begin, end ) : bytes; // a 200 here: a file that ends within the range

		};

	}

	async _loadPage( page, signal ) {

		const { nodes, pages } = await Copc.loadHierarchyPage( this._getter( signal ), page );
		for ( const [ k, n ] of Object.entries( nodes ) ) if ( n ) this.nodes.set( k, n );
		for ( const [ k, p ] of Object.entries( pages ) ) if ( p && ! this.nodes.has( k ) ) this.pendingPages.set( k, p );
		this.stats.pages ++;

	}

	async load( url ) {

		this.url = url;
		this._startWorkers();
		this.copc = await Copc.create( this._getter() );

		const { cube, spacing, rootHierarchyPage, gpsTimeRange } = this.copc.info;
		const format = this.copc.header.pointDataRecordFormat;
		if ( format < 6 || format > 8 ) throw new Error( `COPC: point format ${ format } (6, 7 or 8 expected)` );

		this._gpsBase = Number.isFinite( gpsTimeRange?.[ 0 ] ) ? gpsTimeRange[ 0 ] : 0;
		await this._loadPage( rootHierarchyPage );
		this.metadata = {
			// a file without a spacing falls back to Potree's convention, the cube over 128
			spacing: spacing > 0 && Number.isFinite( spacing ) ? spacing : ( cube[ 3 ] - cube[ 0 ] ) / 128,
			boundingBox: { min: cube.slice( 0, 3 ), max: cube.slice( 3, 6 ) },
		};
		return this.metadata;

	}

	// ── workers: the bytes are copied to them, not transferred, so that a worker that fails hands its jobs back to the page

	_startWorkers() {

		if ( this._wanted <= 0 ) this.workerNote = 'asked for (workers: 0)';
		if ( this._workers.length || this._wanted <= 0 ) return;

		try {

			for ( let i = 0; i < this._wanted; i ++ ) {

				const entry = { worker: new Worker( new URL( './copcWorker.js', import.meta.url ), { type: 'module' } ), busy: 0 };
				entry.worker.onmessage = ( { data } ) => this._onReply( entry, data );
				// the script failed to load, or threw outside a job
				entry.worker.onerror = e => {

					e.preventDefault?.();
					this._dropWorker( entry, e.message || 'worker error' );

				};
				this._workers.push( entry );

			}

		} catch ( e ) {

			this._workers.forEach( w => w.worker.terminate() );
			this._workers = [];
			this.workerNote = `no worker (${ String( e?.message ?? e ).slice( 0, 60 ) })`;

		}

	}

	_onReply( entry, { id, buffer, decodeMs, error } ) {

		const pending = this._jobs.get( id );
		if ( ! pending ) return;

		this._jobs.delete( id );
		entry.busy --;
		if ( error ) return pending.reject( new Error( `COPC: ${ error }` ) );

		this.stats.decodeMs += decodeMs;
		this.stats.workerChunks ++;
		pending.resolve( buffer );

	}

	_dropWorker( entry, why ) {

		this._workers = this._workers.filter( w => w !== entry );
		entry.worker.terminate();
		if ( ! this._workers.length ) this.workerNote = `no worker (${ String( why ).slice( 0, 60 ) })`;

		for ( const [ id, { entry: owner, compressed, job, resolve, reject } ] of this._jobs ) {

			if ( owner !== entry ) continue;
			this._jobs.delete( id );
			this._decodeHere( compressed, job ).then( resolve, reject );

		}

	}

	async _decodeHere( compressed, job ) {

		this._lazPerf ??= loadLazPerf();
		const LazPerf = await this._lazPerf;
		const t0 = performance.now();
		const buffer = decodeChunk( LazPerf, compressed, job );
		const ms = performance.now() - t0;
		this.stats.decodeMs += ms;
		this.stats.mainMs += ms;
		this.stats.mainChunks ++;
		return buffer;

	}

	_decode( compressed, job ) {

		if ( ! this._workers.length ) return this._decodeHere( compressed, job );

		const entry = this._workers.reduce( ( a, b ) => ( b.busy < a.busy ? b : a ) );
		return new Promise( ( resolve, reject ) => {

			const id = ++ this._jobId;
			entry.busy ++;
			this._jobs.set( id, { resolve, reject, entry, compressed, job } );
			entry.worker.postMessage( { id, compressed, job } );

		} );

	}

	dispose() {

		this._workers.forEach( w => w.worker.terminate() );
		this._workers = [];
		this._jobs.forEach( pending => pending.reject( new Error( 'COPC: loader disposed' ) ) );
		this._jobs.clear();

	}

	// ── nodes

	/** The centre of a node's cube, by the same halving as PotreePlugin's tiles. */
	nodeCenter( key ) {

		const { min, max } = this.metadata.boundingBox;
		const lo = [ ...min ], hi = [ ...max ];
		for ( let i = 1; i < key.length; i ++ ) {

			const o = key.charCodeAt( i ) - 48;
			for ( let a = 0; a < 3; a ++ ) {

				const mid = ( lo[ a ] + hi[ a ] ) / 2;
				if ( o & ( 4 >> a ) ) lo[ a ] = mid; else hi[ a ] = mid;

			}

		}

		return lo.map( ( l, a ) => ( l + hi[ a ] ) / 2 );

	}

	/** The node's points, decoded into one packed buffer. Its hierarchy page is read first when it is not yet known. */
	async loadNodeData( key, options = {} ) {

		const k = copcKey( key );
		if ( ! this.nodes.has( k ) && this.pendingPages.has( k ) ) {

			// not tied to this tile's abort signal: the page serves every node under it
			if ( ! this._pageLoads.has( k ) ) {

				const load = this._loadPage( this.pendingPages.get( k ) )
					.then( () => this.pendingPages.delete( k ) )
					.finally( () => this._pageLoads.delete( k ) );
				this._pageLoads.set( k, load );

			}

			await this._pageLoads.get( k );

		}

		const node = this.nodes.get( k );
		if ( ! node ) throw new Error( `COPC: no node ${ k }` );

		const { header } = this.copc;
		const job = {
			pointCount: node.pointCount, format: header.pointDataRecordFormat, recordLength: header.pointDataRecordLength,
			scale: header.scale, offset: header.offset, center: this.nodeCenter( key ), mask: this._mask, wide: this._wide, gpsBase: this._gpsBase,
		};

		// an empty node: nothing to fetch, and the decoder writes its header without laz-perf
		if ( ! node.pointCount ) return decodeChunk( null, null, job );

		const compressed = await Copc.loadCompressedPointDataBuffer( this._getter( options.signal ), node );
		const buffer = await this._decode( compressed, job );
		this.stats.points += node.pointCount;
		this._wide ??= unpack( buffer ).wide;
		return buffer;

	}

	/** A packed buffer → geometry, positions relative to the node's centre as PotreeLoader's. */
	parsePointData( buffer ) {

		const t0 = performance.now();
		const d = unpack( buffer );
		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new BufferAttribute( d.position, 3 ) );
		geometry.setAttribute( 'color', new BufferAttribute( d.color, 3, true ) );
		for ( const name in ATTR ) if ( d[ name ] ) geometry.setAttribute( name, new BufferAttribute( d[ name ], 1 ) );
		this.stats.mainMs += performance.now() - t0;
		return { geometry, center: new Vector3( ...d.center ) };

	}

}

/**
 * COPC in 3DTilesRendererJS. Options are PotreePlugin's (`url`, `pointScale`, and those of
 * PointCloudEffectsPlugin), plus:
 *
 * @param {number} [options.workers]  Decode workers; 0 decodes on the page. Default: min(4, cores − 1).
 * @param {string[]} [options.attributes]  Point attributes kept beside position and colour. Default: all.
 * @param {('local'|'globe')} [options.placement='local']  `globe`: place the cloud on the WGS84 ellipsoid from the file's CRS.
 * @param {string|null} [options.crs=null]  A CRS for a file that declares none (WKT or a proj string).
 */
export class CopcPlugin extends PotreePlugin {

	constructor( options = {} ) {

		super( options );
		this.name = 'COPC_PLUGIN';
		this.workers = options.workers;
		this.attributes = options.attributes;
		this.placementMode = options.placement === 'globe' ? 'globe' : 'local';
		this.crs = options.crs ?? null;

		// What was done with the file's CRS once the root has loaded:
		// `{ placed, note, transform, lon, lat, height, convergence, unit, verticalUnit, crsName }`.
		this.placement = null;
		this._unit = 1; // metres per unit of the file once placed: a point size is in the file's unit

	}

	init( tiles ) {

		super.init( tiles );
		this.loader = new CopcLoader( { workers: this.workers, attributes: this.attributes } );
		this.loader.fetchOptions = tiles.fetchOptions;
		this.loader.fetchData = ( url, options ) => tiles.invokeOnePlugin( plugin => plugin.fetchData && plugin.fetchData( url, options ) );

	}

	dispose() {

		const { loader } = this;
		super.dispose();
		loader?.dispose();

	}

	// PotreePlugin's own, with a transform on the root when the cloud is placed on the globe: it has to be
	// there before `preprocessTileset` reads the root, which the parent's method leaves no room for.
	async loadRootTileset() {

		const { tiles, url, loader } = this;
		let metaUrl = new URL( url ?? tiles.rootURL, location.href ).href;
		tiles.invokeAllPlugins( plugin => metaUrl = plugin.preprocessURL ? plugin.preprocessURL( metaUrl, null ) : metaUrl );
		await loader.load( metaUrl );

		const { spacing, boundingBox: { min, max } } = loader.metadata;
		const c = min.map( ( v, a ) => ( v + max[ a ] ) / 2 );
		const h = min.map( ( v, a ) => ( max[ a ] - v ) / 2 );
		const root = {
			refine: 'ADD',
			geometricError: spacing,
			boundingVolume: { box: [ ...c, h[ 0 ], 0, 0, 0, h[ 1 ], 0, 0, 0, h[ 2 ] ] },
			content: { uri: 'r.potree' },
			children: [],
		};

		const { header, wkt } = loader.copc;
		const crs = wkt || this.crs;
		this.placement = this.placementMode === 'globe'
			? placementFromCrs( crs, [ ...min, ...max ], [ header.min[ 2 ], header.max[ 2 ] ] )
			: { placed: false, note: crs ? 'drawn in the file\'s own coordinates' : 'the file declares no CRS' };

		if ( this.placement.placed ) {

			// distances are then in metres, so the error must be too; the children halve the root's
			root.transform = this.placement.transform;
			this._unit = this.placement.unit;
			root.geometricError = spacing * this._unit;

		}

		const tileset = { asset: { version: '1.1' }, geometricError: Infinity, root };
		tiles.preprocessTileset( tileset, metaUrl.slice( 0, metaUrl.lastIndexOf( '/' ) + 1 ) );
		return tileset;

	}

	// PotreePlugin sizes a point from the spacing, in the file's unit; a placed cloud counts in metres.
	parseToMesh( buffer, tile, extension, uri ) {

		const points = super.parseToMesh( buffer, tile, extension, uri );
		if ( points ) {

			points.userData.fileZ = points.position.z; // the node centre's own Z, before the tile's transform
			points.material.size *= this._unit;

		}

		return points;

	}

	_updateMaterials() {

		super._updateMaterials();
		if ( this._unit !== 1 && this.loader?.metadata ) this.tiles.forEachLoadedModel( scene => scene.material.size *= this._unit );

	}

	// An empty node may have children: its empty geometry keeps the tree growing. A node the hierarchy
	// does not know yet stays a leaf (PotreePlugin would throw).
	_expandChildren( tile, key ) {

		if ( this.loader.hierarchy.has( key ) ) super._expandChildren( tile, key );

	}

}
