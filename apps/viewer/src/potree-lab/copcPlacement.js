/**
 * Where a COPC file sits on the WGS84 globe, from the CRS it declares: the matrix from the file's own
 * coordinates to earth-centred ones (ECEF, metres), fit to be a root tile's `transform`.
 *
 * The tile server's method (packages/core/geo.js, georefFromCrs) with the ellipsoid of
 * 3DTilesRendererJS: the centre of the octree cube goes to longitude and latitude; the x and y columns
 * are the ECEF images of the file's unit vectors there, measured with proj4 over ±50 m, which holds
 * the unit (a foot is 0.3048 m), the grid convergence and the scale factor at once; the z column is the
 * ellipsoid normal times the vertical unit of a compound CRS, else the horizontal one.
 *
 * Not done: heights are taken as ellipsoidal (no geoid: off by the local undulation, tens of metres at
 * most), and the frame is flat, so a cloud wider than about 20 km leaves the ellipsoid at its edges.
 * Never throws: a CRS that is missing or unreadable gives `{ placed: false, note }`.
 */
import proj4 from 'proj4';
import { Vector3 } from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { crsDefinition, unwrapCompoundWkt } from '../../../../packages/core/geo.js';

const DEG = Math.PI / 180;

/** Metres per vertical unit, from the vertical part of a compound WKT; null when there is none. */
export function verticalUnit( wkt ) {

	const at = String( wkt ).search( /VERT_CS\[|VERTCRS\[|VERTICALCRS\[/i );
	const m = at < 0 ? null : /(?:LENGTHUNIT|UNIT)\[\s*"([^"]*)"\s*,\s*([0-9.eE+-]+)/i.exec( String( wkt ).slice( at ) );
	return m && Number( m[ 2 ] ) > 0 ? { name: m[ 1 ], toMetre: Number( m[ 2 ] ) } : null;

}

/**
 * @param {string|undefined} crs  WKT of the file, or anything else proj4 reads (a proj string, `EPSG:<n>`).
 * @param {number[]} cube         [minx, miny, minz, maxx, maxy, maxz] of the octree, in the file's coordinates.
 * @param {number[]} zRange       [min z, max z] of the points, for the height reported.
 * @returns {{ placed: boolean, note: string, transform?: number[], lon?: number, lat?: number, height?: number,
 *   convergence?: number, unit?: number, verticalUnit?: number, crsName?: string }}
 *   `transform` is column-major. Angles in degrees, `height` in metres (the middle of the points' heights),
 *   `unit` the metres one horizontal unit of the file covers on the ground at the centre.
 */
export function placementFromCrs( crs, cube, zRange = [ 0, 0 ] ) {

	if ( ! crs ) return { placed: false, note: 'the file declares no CRS' };

	let P, proj;
	try {

		const horizontal = unwrapCompoundWkt( crsDefinition( String( crs ) ) );
		P = proj4( horizontal, 'WGS84' );
		proj = new proj4.Proj( horizontal );

	} catch ( e ) {

		return { placed: false, note: `proj4 cannot read the CRS of the file${ e?.message ? ` (${ String( e.message ).slice( 0, 80 ) })` : '' }` };

	}

	try {

		const cx = ( cube[ 0 ] + cube[ 3 ] ) / 2, cy = ( cube[ 1 ] + cube[ 4 ] ) / 2;
		const geographic = proj.projName === 'longlat';
		const toMetre = ! geographic && proj.to_meter > 0 ? proj.to_meter : 1;
		const [ lon, lat ] = P.forward( [ cx, cy ] );
		if ( ! Number.isFinite( lon ) || ! ( Math.abs( lat ) <= 90 ) ) return { placed: false, note: 'the CRS of the file gives no position for its centre' };

		const ecef = ( x, y ) => {

			const [ lo, la ] = P.forward( [ x, y ] );
			return WGS84_ELLIPSOID.getCartographicToPosition( la * DEG, lo * DEG, 0, new Vector3() );

		};
		const d = geographic ? 1e-4 : 50 / toMetre; // ±50 m, in the file's unit
		const colX = ecef( cx + d, cy ).sub( ecef( cx - d, cy ) ).divideScalar( 2 * d );
		const colY = ecef( cx, cy + d ).sub( ecef( cx, cy - d ) ).divideScalar( 2 * d );
		const east = new Vector3(), north = new Vector3(), up = new Vector3();
		WGS84_ELLIPSOID.getEastNorthUpAxes( lat * DEG, lon * DEG, east, north, up );
		const origin = WGS84_ELLIPSOID.getCartographicToPosition( lat * DEG, lon * DEG, 0, new Vector3() );
		if ( ! [ colX, colY, origin ].every( v => Number.isFinite( v.x + v.y + v.z ) ) || ! ( colX.length() > 0 ) ) {

			return { placed: false, note: 'the CRS of the file gives no frame at its centre' };

		}

		const vertical = verticalUnit( crs );
		const zUnit = vertical?.toMetre ?? ( geographic ? 1 : toMetre );
		const colZ = up.multiplyScalar( zUnit );
		// file ( x, y, z ) → origin + colX ( x − cx ) + colY ( y − cy ) + colZ z
		const t = origin.addScaledVector( colX, - cx ).addScaledVector( colY, - cy );
		const side = ( cube[ 3 ] - cube[ 0 ] ) * colX.length();
		return {
			placed: true,
			transform: [ ...colX, 0, ...colY, 0, ...colZ, 0, ...t, 1 ],
			lon,
			lat,
			height: ( zRange[ 0 ] + zRange[ 1 ] ) / 2 * zUnit,
			// grid north against true north, positive when grid north points east of true north
			convergence: Math.atan2( colY.dot( east ), colY.dot( north ) ) / DEG,
			unit: colX.length(),
			verticalUnit: zUnit,
			crsName: /^\s*\w+\[\s*"([^"]+)"/.exec( String( crs ) )?.[ 1 ] ?? String( crs ).slice( 0, 40 ),
			note: ( vertical || geographic ? '' : 'no vertical CRS: heights read in the horizontal unit; ' )
				+ ( side > 20000 ? `flat frame over ${ ( side / 1000 ).toFixed( 0 ) } km: the edges leave the ellipsoid; ` : '' )
				+ 'heights taken as ellipsoidal (no geoid)',
		};

	} catch ( e ) {

		return { placed: false, note: `the CRS of the file could not be applied (${ String( e?.message ?? e ).slice( 0, 80 ) })` };

	}

}
