/**
 * Run the repo's CLI as a child process for the launcher's "Export to a folder → Run in: CLI
 * subprocess" option: spawn, capture a bounded output tail, report state, cancel.
 *
 * Kept free of Electrobun imports and with the process-spawning injected, so the same logic runs in
 * the Cottontail main process and under plain Node for testing
 * (`node --experimental-strip-types`, with `nodeSpawn()`).
 *
 * SECURITY. The view decides the arguments, so the main process must not let it run anything else:
 * args[0] has to be one of ALLOWED_SCRIPTS (repo-relative), the executable is always `node`, no shell
 * is involved (an argv array, never a command string), and cli.js's `serve` sub-command and its `--`
 * passthrough to converter binaries are refused.
 */

export const ALLOWED_SCRIPTS = ['packages/convert/cli.js', 'scripts/pack-3dtiles.mjs'] as const;
export const TAIL_LINES = 200;

export type CliState = 'running' | 'done' | 'failed' | 'cancelled';
export interface CliStatus {
  state: CliState;
  exitCode: number | null;
  tail: string[];
  startedAt: number;
  endedAt: number | null;
}

/** What a spawn adapter must provide: output callbacks, an exit promise and a kill. */
export interface SpawnedProcess {
  onOutput(cb: (chunk: string) => void): void;
  exited: Promise<number | null>;
  kill(): void;
}
export type SpawnFn = (cmd: string[], cwd: string) => SpawnedProcess;

/** Throws with a readable message when the view asks for something outside the allow-list. */
export function validateArgs(args: unknown): string[] {
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) {
    throw new Error('args must be a non-empty array of strings');
  }
  const script = String(args[0]).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!(ALLOWED_SCRIPTS as readonly string[]).includes(script)) {
    throw new Error(`not an allowed script: ${args[0]} (allowed: ${ALLOWED_SCRIPTS.join(', ')})`);
  }
  if (args.some((a) => a.includes('\0'))) throw new Error('NUL in argument');
  if (script === 'packages/convert/cli.js') {
    if (args[1] === 'serve') throw new Error('the serve sub-command is not allowed here');
    if (args.includes('--')) throw new Error('the -- converter passthrough is not allowed here');
  }
  return [script, ...args.slice(1)];
}

/**
 * Line assembler for output that redraws a progress line with `\r` (the CLI export does). A segment
 * ended by `\r` is a live line: the next segment REPLACES it instead of adding a line, so the tail
 * reads like the terminal would show it.
 */
export class Tail {
  lines: string[] = [];
  private cur = '';
  private overwrite = false;
  private max: number;
  constructor(max = TAIL_LINES) { this.max = max; }

  push(chunk: string) {
    const parts = chunk.split(/(\r\n|\r|\n)/);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (i % 2 === 0) { this.cur += p; continue; }
      this.commit(p === '\r' ? '\r' : '\n');
    }
  }
  /** Append a line of our own (e.g. the command being run), finishing any partial one first. */
  note(line: string) {
    if (this.cur.trim()) this.commit('\n');
    this.cur = '';
    this.overwrite = false;
    this.add(line);
  }
  snapshot(): string[] {
    const live = this.cur.trim() ? [this.cur.trimEnd()] : [];
    if (live.length && this.overwrite) return [...this.lines.slice(0, -1), ...live];
    return [...this.lines, ...live];
  }
  private commit(term: '\r' | '\n') {
    const text = this.cur.trimEnd();
    this.cur = '';
    if (!text.trim()) { if (term === '\n') this.overwrite = false; return; }
    if (this.overwrite && this.lines.length) this.lines[this.lines.length - 1] = text;
    else this.add(text);
    this.overwrite = term === '\r';
  }
  private add(line: string) {
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }
}

interface Job extends Omit<CliStatus, 'tail'> { tail: Tail; proc: SpawnedProcess | null; cancelled: boolean }

/**
 * A registry of CLI jobs. `run` takes one or more argv steps (e.g. convert, then pack) and runs them
 * in sequence, stopping at the first non-zero exit.
 */
export function createCliRunner(opts: { spawn: SpawnFn; cwd: string; node?: string; keep?: number }) {
  const jobs = new Map<string, Job>();
  const node = opts.node ?? 'node';
  let seq = 0;

  function prune() {
    const finished = [...jobs.entries()].filter(([, j]) => j.state !== 'running');
    for (const [id] of finished.slice(0, Math.max(0, finished.length - (opts.keep ?? 20)))) jobs.delete(id);
  }

  async function drive(job: Job, steps: string[][]) {
    for (const args of steps) {
      if (job.cancelled) break;
      const cmd = [node, ...args];
      job.tail.note(`$ node ${args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
      let code: number | null;
      try {
        const p = opts.spawn(cmd, opts.cwd);
        job.proc = p;
        p.onOutput((c) => job.tail.push(c));
        code = await p.exited;
      } catch (e) {
        job.tail.note(`[desktop] could not start node: ${(e as Error).message}`);
        code = null;
      }
      job.proc = null;
      job.exitCode = code;
      if (job.cancelled || code !== 0) break;
    }
    job.state = job.cancelled ? 'cancelled' : job.exitCode === 0 ? 'done' : 'failed';
    job.endedAt = Date.now();
    if (job.state !== 'done') job.tail.note(`[desktop] ${job.state}${job.exitCode != null ? ` (exit code ${job.exitCode})` : ''}`);
    prune();
  }

  return {
    /** Validate every step, then start. Returns the job id immediately. */
    run(steps: unknown[]): string {
      const clean = steps.map(validateArgs);
      const id = `cli-${Date.now().toString(36)}-${++seq}`;
      const job: Job = { state: 'running', exitCode: null, tail: new Tail(), startedAt: Date.now(), endedAt: null, proc: null, cancelled: false };
      jobs.set(id, job);
      void drive(job, clean);
      return id;
    },
    status(id: string): CliStatus | null {
      const j = jobs.get(id);
      if (!j) return null;
      return { state: j.state, exitCode: j.exitCode, tail: j.tail.snapshot(), startedAt: j.startedAt, endedAt: j.endedAt };
    },
    cancel(id: string): boolean {
      const j = jobs.get(id);
      if (!j || j.state !== 'running') return false;
      j.cancelled = true;
      try { j.proc?.kill(); } catch { /* already gone */ }
      return true;
    },
    /** Kill everything still running (app quit). */
    killAll() {
      for (const id of jobs.keys()) this.cancel(id);
    },
  };
}

// ── spawn adapters ─────────────────────────────────────────────────────────────────────────────────

/** node:child_process, loaded once; a non-literal specifier because this tsconfig carries no Node typings. */
const CHILD_PROCESS = 'node:child_process';
let cp: any = null;
const childProcess = async (): Promise<any> => (cp ??= await import(CHILD_PROCESS));

/**
 * Kill a process and its descendants. The CLI is a direct node child (no shell), so a plain kill
 * reaches it; `taskkill /T` additionally takes down anything a converter started (on Windows a
 * killed parent does not take its children with it). Synchronous, so it also works from an `exit`
 * handler — the module is preloaded by defaultSpawn()/nodeSpawn().
 */
function killTree(pid: number | undefined, fallback: () => void) {
  const proc = (globalThis as any).process;
  if (pid && cp && proc?.platform === 'win32') {
    try {
      cp.execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch { /* already exited, or no taskkill: fall through */ }
  }
  fallback();
}

/** node:child_process adapter (plain Node, and Cottontail if it has no Bun.spawn). */
export async function nodeSpawn(): Promise<SpawnFn> {
  const { spawn } = await childProcess();
  return (cmd, cwd) => {
    const env = (globalThis as any).process?.env;
    const p = spawn(cmd[0]!, cmd.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const listeners: ((c: string) => void)[] = [];
    const emit = (b: unknown) => { const s = String(b); for (const l of listeners) l(s); };
    p.stdout?.setEncoding('utf8'); p.stderr?.setEncoding('utf8');
    p.stdout?.on('data', emit); p.stderr?.on('data', emit);
    const exited = new Promise<number | null>((resolve, reject) => {
      p.once('error', reject);
      p.once('close', (code: number | null) => resolve(code));
    });
    return {
      onOutput: (cb) => { listeners.push(cb); },
      exited,
      kill: () => { killTree(p.pid, () => { try { p.kill(); } catch { /* gone */ } }); },
    };
  };
}

/** Bun-style adapter (Cottontail exposes Bun.spawn). Streams are read defensively: web or node style. */
export function bunSpawn(Bun: any): SpawnFn {
  return (cmd, cwd) => {
    const env = (globalThis as any).process?.env;
    const p = Bun.spawn(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const listeners: ((c: string) => void)[] = [];
    const emit = (s: string) => { for (const l of listeners) l(s); };
    const pump = async (stream: any) => {
      if (!stream) return;
      if (typeof stream.getReader === 'function') {
        const reader = stream.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          emit(dec.decode(value, { stream: true }));
        }
      } else if (typeof stream.on === 'function') {
        await new Promise<void>((res) => { stream.on('data', (b: unknown) => emit(String(b))); stream.on('end', res); stream.on('close', res); });
      }
    };
    const drained = Promise.all([pump(p.stdout), pump(p.stderr)]).catch(() => {});
    // resolve after output is drained so the tail holds the final summary line
    const exited = Promise.resolve(p.exited).then(async (code: number | null) => { await drained; return code; });
    return {
      onOutput: (cb) => { listeners.push(cb); },
      exited,
      kill: () => { killTree(p.pid, () => { try { p.kill(); } catch { /* gone */ } }); },
    };
  };
}

/** Bun.spawn when the runtime has it, else node:child_process. */
export async function defaultSpawn(): Promise<SpawnFn> {
  const Bun = (globalThis as any).Bun;
  await childProcess().catch(() => null);   // for killTree
  return Bun?.spawn ? bunSpawn(Bun) : nodeSpawn();
}
