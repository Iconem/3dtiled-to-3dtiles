/**
 * http.js — tiny HTTP response helpers shared by every live adapter's request handler.
 * Removes the repeated CORS object + writeHead/end boilerplate from each handle<Fmt>.
 */
export const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

export const sendJson = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(obj)); };
export const sendGlb  = (res, buf) => { res.writeHead(200, { 'Content-Type': 'model/gltf-binary', ...CORS }); res.end(buf); };
export const sendBin  = (res, buf) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...CORS }); res.end(buf); };
export const sendErr  = (res, code, msg) => { res.writeHead(code, CORS); res.end(msg); };
