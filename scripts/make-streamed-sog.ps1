<#
.SYNOPSIS
  Builds a streamed SOG (lod-meta.json + chunk files) from one PLY with splat-transform's chained 50 % recipe,
  then, optionally, converts it to 3D Tiles with this repo's converter.

.DESCRIPTION
  Three steps, each one restartable (a level that exists is not rebuilt):

    1. lod0 = the source with its SH bands dropped (-H 0, DC colour only) and Morton-ordered once (-m).
    2. lod1 .. lod<Levels-1> = each `--decimate-adaptive 50%` of the PREVIOUS level (not of the source):
       adaptive decimation merges neighbouring pairs by moment matching, so busy geometry keeps its detail and
       flat walls thin out first. Decimation must be the last action of a splat-transform run and writes a PLY,
       so each level is one invocation.
    3. the levels are bundled, tagged -l <level>, into <OutDir>\lod-meta.json with the four chunking flags.
       Only this step re-runs when the leaf or file flags change.

  Then `3dtiled <OutDir>\lod-meta.json <TilesDir> --splat-budget <SplatBudget>` writes the 3D Tiles, unless
  -NoTiles. See apps/docs/content/docs/references/3dgs-splats/streamed-sog.mdx ("Producing one").

  Sizing: a 174 M-splat PLY (43 GB, SH3) needs about 120 GB free (source + ~12 GB of levels + the bundle) and
  took 2 min for lod0, ~26 min for lod0 -> lod1 on an RTX 4090 (faster for each level after), 9 min to bundle.
  The default heap below is 96 GB: lower it on a smaller machine (-HeapMB).

.PARAMETER InputPly       the source PLY (default .\input.ply)
.PARAMETER OutDir         where lods\ and the bundle go (default .\output-streamed-sog)
.PARAMETER TilesDir       where the 3D Tiles go (default .\output-3dtiles)
.PARAMETER Levels         number of LOD levels, lod0 included (default 10: lod9 is 1/512 of the source)
.PARAMETER ChunkExtent    --lod-chunk-extent, metres: a leaf wider than this is split (default 8; splat-transform's is 16)
.PARAMETER ChunkCount     --lod-chunk-count, K splats per leaf summed over all levels (default 64; splat-transform's is 512)
.PARAMETER ChunkMin       --lod-chunk-min, K splats below which a wide leaf is not split, keeps sky and background whole (default 16)
.PARAMETER FileCount      --lod-file-count, K splats per file, what a viewer downloads whole (default 512)
.PARAMETER Rotate         `-r x,y,z` applied to every input, e.g. "-90,0,0" for a Blender Z-up scene into the Y-down PlayCanvas frame (default none)
.PARAMETER Gpu            splat-transform GPU index (`--list-gpus`; the default adapter can be the iGPU)
.PARAMETER SplatBudget    the converter's --splat-budget (default 100000)
.PARAMETER SplatTransform the npm spec to run (default @playcanvas/splat-transform@3.11.1)
.PARAMETER HeapMB         Node heap for splat-transform, MB (default 98304)
.PARAMETER NoTiles        stop after the bundle

.EXAMPLE
  .\scripts\make-streamed-sog.ps1 -InputPly D:\scene\input.ply -OutDir D:\scene\sog -TilesDir D:\scene\output-3dtiles -Rotate "-90,0,0" -Gpu 0
#>
param(
  [string]$InputPly = ".\input.ply",
  [string]$OutDir = ".\output-streamed-sog",
  [string]$TilesDir = ".\output-3dtiles",
  [int]$Levels = 10,
  [double]$ChunkExtent = 8,
  [int]$ChunkCount = 64,
  [int]$ChunkMin = 16,
  [int]$FileCount = 512,
  [string]$Rotate = "",
  [int]$Gpu = -1,
  [int]$SplatBudget = 100000,
  [string]$SplatTransform = "@playcanvas/splat-transform@3.11.1",
  [int]$HeapMB = 98304,
  [switch]$NoTiles
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $InputPly)) { throw "input PLY not found: $InputPly" }
if ($Levels -lt 2) { throw "-Levels must be at least 2" }
$env:NODE_OPTIONS = "--max-old-space-size=$HeapMB"
$OutDir = (New-Item -ItemType Directory -Force $OutDir).FullName
$lods = (New-Item -ItemType Directory -Force (Join-Path $OutDir 'lods')).FullName
$gpuArgs = @(); if ($Gpu -ge 0) { $gpuArgs = @('-g', "$Gpu") }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here

function St { param([string[]]$Args)
  Write-Host ">> splat-transform $($Args -join ' ')" -ForegroundColor Cyan
  & npx --yes $SplatTransform @Args
  if ($LASTEXITCODE -ne 0) { throw "splat-transform failed (exit $LASTEXITCODE): $($Args -join ' ')" }
}
function Count { param([string]$Ply)
  $line = (& npx --yes $SplatTransform $Ply --info null | Select-String '^gaussians:') -replace 'gaussians:\s*', ''
  if ($line) { [int64]($line.Trim()) } else { -1 }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
Write-Host "source: $InputPly ($([math]::Round((Get-Item $InputPly).Length / 1GB, 1)) GB)"

# ---------- 1. lod0: SH dropped, Morton-ordered ----------
$lod0 = Join-Path $lods 'lod0.ply'
if (Test-Path $lod0) { Write-Host "lod0 exists, kept" } else { St @('-w', $InputPly, '-H', '0', '-m', $lod0, '--memory') }

# ---------- 2. lod1 .. lodN: each 50 % of the previous ----------
for ($i = 1; $i -lt $Levels; $i++) {
  $prev = Join-Path $lods "lod$($i - 1).ply"; $next = Join-Path $lods "lod$i.ply"
  if (Test-Path $next) { Write-Host "lod$i exists, kept"; continue }
  St (@('-w') + $gpuArgs + @($prev, '--decimate-adaptive', '50%', $next, '--memory'))
  Write-Host ("lod$i done at {0:n0} s" -f $sw.Elapsed.TotalSeconds)
}
Write-Host "levels:"; 0..($Levels - 1) | ForEach-Object { "  lod$_ : {0:n0} splats" -f (Count (Join-Path $lods "lod$_.ply")) }

# ---------- 3. bundle the levels into one streamed SOG ----------
$inputs = @()
0..($Levels - 1) | ForEach-Object {
  $inputs += (Join-Path $lods "lod$_.ply")
  if ($Rotate) { $inputs += @('-r', $Rotate) }
  $inputs += @('-l', "$_")
}
$meta = Join-Path $OutDir 'lod-meta.json'
St (@('-w') + $gpuArgs + $inputs + @(
  '--lod-chunk-extent', "$ChunkExtent", '--lod-chunk-count', "$ChunkCount", '--lod-chunk-min', "$ChunkMin",
  '--lod-file-count', "$FileCount", '--max-workers', '8', '--memory', $meta))
& npx --yes $SplatTransform $meta --info null

# every chunk file the manifest names must exist
$m = Get-Content $meta -Raw | ConvertFrom-Json
$missing = @(foreach ($f in $m.filenames) {
  $mp = Join-Path $OutDir $f
  if (-not (Test-Path $mp)) { $mp; continue }
  $dir = Split-Path $mp; $cm = Get-Content $mp -Raw | ConvertFrom-Json
  foreach ($p in $cm.PSObject.Properties) { foreach ($x in @($p.Value.files)) { if ($x -and -not (Test-Path (Join-Path $dir $x))) { Join-Path $dir $x } } }
})
Write-Host ("bundle: {0} chunks listed, {1} files missing, {2:n0} s so far" -f $m.filenames.Count, $missing.Count, $sw.Elapsed.TotalSeconds)
if ($missing.Count) { $missing | ForEach-Object { Write-Host "  missing $_" }; throw "the bundle is incomplete" }
if ($NoTiles) { exit 0 }

# ---------- 4. 3D Tiles ----------
$cli = Join-Path $repo 'packages\convert\cli.js'
Write-Host ">> node $cli $meta $TilesDir --splat-budget $SplatBudget" -ForegroundColor Cyan
& node $cli $meta $TilesDir --splat-budget $SplatBudget
if ($LASTEXITCODE -ne 0) { throw "3dtiled failed (exit $LASTEXITCODE)" }
Write-Host ("done in {0:n0} s: {1}\tileset.json" -f $sw.Elapsed.TotalSeconds, (Resolve-Path $TilesDir))
