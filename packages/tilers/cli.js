#!/usr/bin/env node
/**
 * 3dtiled-tile — the one-stop tiler's command line: run a third-party tiler on raw input, get something to stream.
 *
 *   node packages/tilers/cli.js list [--json]                 the tools, what they take and write, their options
 *   node packages/tilers/cli.js detect [<tool>] [--json]      which are on this machine, and where
 *   node packages/tilers/cli.js for <input> [--json]          the tools that take this file or folder
 *   node packages/tilers/cli.js samples <folder>              write tiny synthetic inputs to try the tools on
 *   node packages/tilers/cli.js install <tool>                download a tool that publishes a binary (hash-checked)
 *   node packages/tilers/cli.js run <tool> <input> <outDir> [--<option> <value>]… [--install] [--overwrite] [--dry-run]
 *
 * `run` prints the tool's own output as it comes, then one line a caller can parse:
 *   TILER_RESULT {"tool":"potreeconverter","format":"potree","output":"…/metadata.json",…}
 * which is the path and format to give to `3dtiled serve` or to the desktop app's stream flow. `--json` on the other
 * commands prints one `TILER_JSON …` line the same way. `--install` fetches a missing tool first.
 *
 * The desktop app runs this file through its subprocess runner; options are checked against the tool's declared ones,
 * so nothing the caller sends reaches a command line unchecked.
 */
import fs from 'node:fs';
import { TOOLS, listTools, detectTool, installTool, planRun, runTool, toolsFor, describeInput, toolsDir, stepLine } from './index.js';
import { writeSamples, SAMPLES } from './samples.js';

const argv = process.argv.slice(2), cmd = argv[0];
const json = argv.includes('--json');
const out = (data, text) => (json ? console.log(`TILER_JSON ${JSON.stringify(data)}`) : console.log(text));
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

const where = (d) => (d.status === 'ready' ? `${d.source}${d.hint ? ` (${d.hint})` : ''}: ${d.exe.join(' ')}` : d.hint);

try {
  if (cmd === 'list') {
    const tools = listTools();
    out({ tools, toolsDir: toolsDir() }, tools.map((t) =>
      `${t.id.padEnd(16)} ${t.inputs.map((e) => '.' + e).join(' ')} → ${t.output.label}   [${t.delivery}${t.version ? ` ${t.version}` : ''}, ${t.licence}]\n` +
      `${' '.repeat(17)}${t.summary}\n` +
      t.options.map((o) => `${' '.repeat(17)}--${o.key} <${o.type === 'enum' ? o.values.join('|') : o.type}>  default ${JSON.stringify(o.default)}  ${o.help}`).join('\n')).join('\n\n'));
  } else if (cmd === 'detect') {
    const ids = argv[1] && !argv[1].startsWith('--') ? [argv[1]] : TOOLS.map((t) => t.id);
    const found = ids.map((id) => detectTool(id));
    out({ tools: found, toolsDir: toolsDir() }, found.map((d) => `${d.id.padEnd(16)} ${d.status.padEnd(8)} ${where(d)}`).join('\n'));
  } else if (cmd === 'for') {
    if (!argv[1]) fail('usage: for <input>');
    const d = describeInput(argv[1]), ids = toolsFor(d);
    const what = d.dir ? `a folder holding ${d.exts.map((e) => '.' + e).join(', ') || 'no file'}` : `a .${d.ext} file${d.ply ? ` of ${d.ply === 'mesh' ? 'a mesh' : d.ply}` : ''}`;
    out({ input: d, tools: ids }, ids.length ? ids.join('\n') : `no tool takes ${what}: ${argv[1]}`);
  } else if (cmd === 'samples') {
    if (!argv[1] || argv[1].startsWith('--')) fail('usage: samples <folder>');
    const files = writeSamples(argv[1]);
    out({ dir: argv[1], files, samples: SAMPLES }, files.map((f) => `${String(fs.statSync(f).size).padStart(8)} B  ${f}`).join('\n') + '\n' + SAMPLES.map((s) => `${s.file}: ${s.about}`).join('\n'));
    console.log(`TILER_SAMPLES ${JSON.stringify({ dir: argv[1], files })}`);
  } else if (cmd === 'install') {
    if (!argv[1]) fail('usage: install <tool>');
    const r = await installTool(argv[1], { log: (l) => console.log(l), force: argv.includes('--force') });
    out(r, r.downloaded ? `ready: ${r.exe}` : `already installed: ${r.exe}`);
  } else if (cmd === 'run') {
    const pos = [], opts = {}, flags = new Set();
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const key = a.slice(2);
      if (['install', 'overwrite', 'dry-run', 'json'].includes(key)) { flags.add(key); continue; }
      const eq = key.indexOf('=');
      if (eq > 0) opts[key.slice(0, eq)] = key.slice(eq + 1);
      else { if (i + 1 >= argv.length) fail(`--${key} needs a value`); opts[key] = argv[++i]; }
    }
    const [id, input, outDir] = pos;
    if (!id || !input || !outDir) fail('usage: run <tool> <input> <outDir> [--<option> <value>]… [--install] [--overwrite] [--dry-run]');
    if (flags.has('install') && detectTool(id).status !== 'ready') await installTool(id, { log: (l) => console.log(l) });
    if (flags.has('dry-run')) {
      const plan = planRun(id, input, outDir, opts);
      out({ steps: plan.steps.map((s) => s.cmd ?? s.copy ?? s.move), output: plan.output, options: plan.options }, plan.steps.map((s) => `$ ${stepLine(s)}`).join('\n') + `\n→ ${plan.output.path} (${plan.output.format})`);
    } else {
      const r = await runTool(id, input, outDir, opts, { overwrite: flags.has('overwrite') });
      console.log(`Done in ${r.seconds < 60 ? r.seconds.toFixed(1) + ' s' : (r.seconds / 60).toFixed(1) + ' min'} → ${r.output}`);
      console.log(`TILER_RESULT ${JSON.stringify(r)}`);
    }
  } else {
    console.log('usage: 3dtiled-tile list | detect [tool] | for <input> | samples <folder> | install <tool> | run <tool> <input> <outDir> [--<option> <value>]… [--install] [--overwrite] [--dry-run]   (add --json for a machine-readable line)');
    process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
  }
} catch (e) { fail(e.message); }
