
// The Draco decoder alone (the package's entry also pulls the encoder); it ships no types.
declare module 'draco3dgltf/draco_decoder_gltf_nodejs.js' {
  const createDecoderModule: (options: { wasmBinary: ArrayBuffer }) => Promise<unknown>;
  export default createDecoderModule;
}
