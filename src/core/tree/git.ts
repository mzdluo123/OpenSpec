import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { GIT_EXEC_OPTIONS } from '../store/git.js';

const execFileAsync = promisify(execFile);

/**
 * Read-only git access for drift checks and redirect import. Every failure
 * resolves to null so callers degrade to "no git facts" instead of failing.
 * Results are cached per instance: one reader serves one command run.
 */
export class GitReader {
  private readonly cache = new Map<string, Promise<string | null>>();
  private topLevel?: Promise<string | null>;

  constructor(private readonly cwd: string) {}

  private run(args: string[]): Promise<string | null> {
    const key = args.join('\u0000');
    let pending = this.cache.get(key);
    if (!pending) {
      pending = execFileAsync('git', args, { ...GIT_EXEC_OPTIONS, cwd: this.cwd })
        .then(({ stdout }) => stdout)
        .catch(() => null);
      this.cache.set(key, pending);
    }
    return pending;
  }

  async repoRoot(): Promise<string | null> {
    this.topLevel ??= this.run(['rev-parse', '--show-toplevel']).then((out) => (out ? out.trim() : null));
    return this.topLevel;
  }

  /** Full commit id for `ref`, or null when it does not resolve. */
  async verifyRef(ref: string): Promise<string | null> {
    const out = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return out ? out.trim() : null;
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const out = await this.run(['merge-base', a, b]);
    return out ? out.trim() : null;
  }

  /** File content at `rev`, addressed by an absolute path inside the work tree. */
  async showFile(rev: string, absolutePath: string): Promise<string | null> {
    const root = await this.repoRoot();
    if (!root) return null;
    const relative = path.relative(root, absolutePath).split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return this.run(['show', `${rev}:${relative}`]);
  }

  /**
   * Renames of `spec.md` files under `specsDir` in `range`, oldest first, as
   * capability paths relative to `specsDir`.
   */
  async specRenames(
    range: string,
    specsDir: string
  ): Promise<Array<{ commit: string; date: string; from: string; to: string }> | null> {
    const root = await this.repoRoot();
    if (!root) return null;
    const specsRelative = path.relative(root, specsDir).split(path.sep).join('/');
    const out = await this.run([
      'log',
      '--reverse',
      '--no-color',
      '-M',
      '--name-status',
      '--format=commit %H %cs',
      range,
      '--',
      specsRelative,
    ]);
    if (out === null) return null;
    const renames: Array<{ commit: string; date: string; from: string; to: string }> = [];
    let commit = '';
    let date = '';
    const toCapability = (file: string): string | undefined => {
      const prefix = `${specsRelative}/`;
      if (!file.startsWith(prefix) || !file.endsWith('/spec.md')) return undefined;
      return file.slice(prefix.length, -'/spec.md'.length);
    };
    for (const line of out.split('\n')) {
      const header = line.match(/^commit ([0-9a-f]+) (\S+)$/);
      if (header) {
        commit = header[1];
        date = header[2];
        continue;
      }
      const rename = line.match(/^R\d*\t([^\t]+)\t([^\t]+)$/);
      if (!rename) continue;
      const from = toCapability(rename[1]);
      const to = toCapability(rename[2]);
      if (from !== undefined && to !== undefined && from !== to) renames.push({ commit, date, from, to });
    }
    return renames;
  }
}
