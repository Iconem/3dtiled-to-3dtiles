# spark-rad-wasm

Spark's own RAD decoder as a WebAssembly module for Node. The crate is a thin wrapper: the bytes go to
`spark_lib::rad` ([sparkjsdev/spark](https://github.com/sparkjsdev/spark), `rust/spark-lib`, MIT, World Labs
Technologies) and what it hands its receiver comes back as typed arrays.

- `radHeader(bytes)`: the file header's JSON and where the chunks start.
- `decodeRadChunk(bytes)`: one `RADC` chunk decoded into columns (centre, opacity, colour, scale, rotation, the
  spherical-harmonic bands, the level-of-detail children).

The built module is committed in `../../vendor/spark-rad-wasm` (250 KB), so nothing here needs Rust to run, and CI
does not build it. `../../src/sparkRad.js` is the JavaScript side.

## Rebuild

Only when Spark changes the format, or to move the pin:

1. set the new commit in `Cargo.toml` (`rev = "…"`). Pinned today: `ffe210dc`, Spark 2.4.0;
2. build, then copy the module:

```sh
rustup target add wasm32-unknown-unknown
cargo binstall wasm-pack          # or: cargo install wasm-pack
wasm-pack build --target nodejs --release --out-dir pkg
cp pkg/spark_rad_wasm.js pkg/spark_rad_wasm_bg.wasm pkg/spark_rad_wasm.d.ts pkg/package.json ../../vendor/spark-rad-wasm/
```

3. run `node --test packages/tile-server/spark-rad.test.js`, and on real files
   `node scripts/compare-rad-readers.mjs <a .rad url> 6`: our reader and Spark's must still agree.

Built here with rustc 1.96.0 and wasm-pack 0.15.1 (wasm-bindgen 0.2.130).
