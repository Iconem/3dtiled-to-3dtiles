#!/bin/sh
# tilers-smoke.sh — install each downloadable tiler for THIS platform and run it on the package's tiny samples.
#   sh scripts/tilers-smoke.sh [work-dir]
# One line per tool: OK (with the file count of its output), SKIP (the project publishes no build for this platform)
# or FAIL (with the lines of its log that say why, then the end of the log).
# Exit code: the number of tools that failed. Used by .github/workflows/tilers-platforms.yml (macOS, Linux arm64).
WORK=${1:-${TMPDIR:-/tmp}/tilers-smoke}
mkdir -p "$WORK"
node -e "console.log('platform', process.platform, process.arch, 'node', process.version)"
node packages/tilers/cli.js samples "$WORK/in" > /dev/null || { echo "FAIL samples"; exit 99; }
fails=0; skips=0
run() {
  id=$1; in=$2; shift 2
  rm -rf "$WORK/out-$id"
  if node packages/tilers/cli.js run "$id" "$in" "$WORK/out-$id" --install "$@" > "$WORK/log-$id.txt" 2>&1; then
    echo "OK   $id [$(find "$WORK/out-$id" -type f | wc -l | tr -d ' ') files]"
  elif grep -q 'no download is published' "$WORK/log-$id.txt"; then
    skips=$((skips + 1))
    echo "SKIP $id: no build is published for this platform"
  else
    fails=$((fails + 1))
    echo "FAIL $id: $(grep -i -E 'error|cannot|not found|no such|unsupported|GLIBC|dyld|denied|exception' "$WORK/log-$id.txt" | head -3 | cut -c1-300)"
    echo "---- last lines of its log"; tail -25 "$WORK/log-$id.txt" | cut -c1-300; echo "----"
  fi
}
run potreeconverter "$WORK/in/points.las"
run gocesiumtiler "$WORK/in/points.las" --crs 32631
run rusty-tiles-points "$WORK/in/points.las" --sourceCrs EPSG:32631
run point-tiler "$WORK/in/points.las" --inputEpsg 32631
run py3dtiles "$WORK/in/points.las" --srsIn 32631
run obj2tiles "$WORK/in/mesh/mesh.obj"
run rusty-tiles "$WORK/in/mesh.glb"
run nexus "$WORK/in/mesh.ply"
run mago-3d-tiler "$WORK/in/points.las" --crs 32631
run splat-transform "$WORK/in/splats.ply" --gpu cpu
run gocesiumtiler-splats "$WORK/in/splats.ply"
run 3dgs-ply-3dtiles-converter "$WORK/in/splats.ply"
echo "--- detect"
node packages/tilers/cli.js detect 2>&1 | cut -c1-160
echo "--- $fails tool(s) failed, $skips without a build for this platform"
exit $fails
