/**
 * gstack-slug's degraded-ancestor heal probe runs once per cache entry, not on
 * every cache hit.
 *
 * The probe (bin/gstack-slug section 1b, twin in lib/bin-context.ts) asks git
 * for the project root's origin and then walks for a remote-bearing repo
 * below it: 1-3 git spawns. It fires whenever the cached slug equals the
 * project root's basename and the root has a `.git` entry, which is the
 * steady state of every remoteless repo and every legit #2212 sticky repo.
 * Before this change those projects paid the spawns at every skill start.
 * A sentinel in slug-cache/heal-probed/ now records the entry a probe
 * cleared; the entry files keep their "v2:<slug>" format, so older readers
 * parse them unchanged.
 *
 * Git spawns are counted through a PATH shim that logs each invocation and
 * execs the real git (the pattern of test/gstack-slug-parity.test.ts).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SLUG_SCRIPT = path.join(ROOT, 'bin', 'gstack-slug');
const BIN_CONTEXT = path.join(ROOT, 'lib', 'bin-context.ts');
const PROBE = 'remote get-url origin';

let tmpHome: string;
let fixtures: string;
let shimDir: string;
let log: string;

beforeEach(() => {
  // realpathSync: macOS tmpdir is a symlink; the scripts key on the physical cwd.
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slug-heal-home-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slug-heal-fix-')));
  shimDir = path.join(fixtures, 'git-shim');
  log = path.join(fixtures, 'git-calls.log');
  fs.mkdirSync(shimDir);
  const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
  fs.writeFileSync(path.join(shimDir, 'git'), `#!/usr/bin/env bash\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(fixtures, { recursive: true, force: true }); } catch {}
});

function env(): Record<string, string | undefined> {
  const { GSTACK_PROJECT_SLUG: _drop, ...ambient } = process.env;
  return { ...ambient, HOME: tmpHome, GSTACK_HOME: path.join(tmpHome, '.gstack'), PATH: `${shimDir}:${process.env.PATH}` };
}

/** Run one resolver in `cwd`; returns its slug and the git probe spawns it made. */
function resolve(cwd: string, via: 'bash' | 'ts' = 'bash'): { slug: string; probes: number } {
  fs.writeFileSync(log, '');
  const r = via === 'bash'
    ? spawnSync('bash', [SLUG_SCRIPT, '--get', 'SLUG'], { cwd, env: env(), encoding: 'utf8', timeout: 10_000 })
    : spawnSync(process.execPath, ['-e',
      `const { slugFromEnvironment } = await import(${JSON.stringify(BIN_CONTEXT)}); console.log(slugFromEnvironment(process.env.GSTACK_HOME, process.cwd()));`,
    ], { cwd, env: env(), encoding: 'utf8', timeout: 20_000 });
  expect(r.status).toBe(0);
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.includes(PROBE));
  return { slug: r.stdout.trim(), probes: calls.length };
}

/** git init with an optional origin. The config is backdated so a sentinel written
 *  in the same second as `git init` still reads as newer under bash 3.2's
 *  one-second `-nt` (the sentinel is trusted only when strictly newer). */
function makeRepo(dir: string, originUrl?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', dir], { timeout: 10_000 });
  if (originUrl) spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl], { timeout: 10_000 });
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, '.git', 'config'), past, past);
  return dir;
}

const cacheFile = (dir: string) => path.join(tmpHome, '.gstack', 'slug-cache', path.join(dir, '.git').replace(/\//g, '_'));

describe('gstack-slug degraded-heal probe is single-shot per cache entry', () => {
  test('remoteless repo: the first cache hit probes, later hits spawn no probe', () => {
    const repo = makeRepo(path.join(fixtures, 'lonely'));
    expect(resolve(repo).slug).toBe('lonely'); // fresh resolve writes the cache
    const firstHit = resolve(repo);
    expect(firstHit).toEqual({ slug: 'lonely', probes: 2 }); // root origin + remote walk
    expect(resolve(repo)).toEqual({ slug: 'lonely', probes: 0 });
    expect(resolve(repo)).toEqual({ slug: 'lonely', probes: 0 });
    // The entry keeps the format older readers parse; the sentinel lives apart.
    expect(fs.readFileSync(cacheFile(repo), 'utf8')).toBe('v2:lonely');
    expect(fs.readdirSync(path.join(tmpHome, '.gstack', 'slug-cache', 'heal-probed'))).toHaveLength(1);
  });

  test('legit #2212 sticky repo: one probe, then none, and the sticky slug holds', () => {
    const repo = makeRepo(path.join(fixtures, 'stickyproj'), 'https://github.com/x/y.git');
    const dir = path.join(tmpHome, '.gstack', 'slug-cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile(repo), 'v2:stickyproj');
    expect(resolve(repo)).toEqual({ slug: 'stickyproj', probes: 1 });
    expect(resolve(repo)).toEqual({ slug: 'stickyproj', probes: 0 });
  });

  test('a repo below a stray .git that gains a remote after the sentinel still heals', () => {
    const strayHome = path.join(fixtures, 'strayhome');
    fs.mkdirSync(path.join(strayHome, '.git'), { recursive: true });
    const repo = makeRepo(path.join(strayHome, 'git', 'proj'));
    expect(resolve(repo).slug).toBe('strayhome'); // no remote anywhere: basename fallback
    expect(resolve(repo).slug).toBe('strayhome'); // probe clears the entry, sentinel written
    expect(resolve(repo)).toEqual({ slug: 'strayhome', probes: 0 });

    // `git remote add` rewrites the repo's config, which is now not older than
    // the sentinel, so the next hit probes again and the heal fires.
    spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/garrytan/gstack'], { timeout: 10_000 });
    expect(resolve(repo).slug).toBe('garrytan-gstack');
    expect(fs.readFileSync(cacheFile(repo), 'utf8')).toBe('v2:garrytan-gstack');
  });

  for (const via of ['bash', 'ts'] as const) {
    test(`${via}: an intermediate repo that gains a remote after the sentinel still heals`, () => {
      // stray .git > outer repo > inner repo (the cwd): the probe asks outer
      // too, so outer's config invalidates the sentinel like the cwd repo's.
      const strayHome = path.join(fixtures, 'strayhome');
      fs.mkdirSync(path.join(strayHome, '.git'), { recursive: true });
      const outer = makeRepo(path.join(strayHome, 'outer'));
      const inner = makeRepo(path.join(outer, 'inner'));
      expect(resolve(inner, via).slug).toBe('strayhome');
      expect(resolve(inner, via).slug).toBe('strayhome'); // probe clears the entry
      expect(resolve(inner, via)).toEqual({ slug: 'strayhome', probes: 0 });

      spawnSync('git', ['-C', outer, 'remote', 'add', 'origin', 'https://github.com/garrytan/gstack'], { timeout: 10_000 });
      expect(resolve(inner, via).slug).toBe('garrytan-gstack');
    });
  }

  test('a pre-fix degraded entry still heals on its first hit', () => {
    const strayHome = path.join(fixtures, 'strayhome');
    fs.mkdirSync(path.join(strayHome, '.git'), { recursive: true });
    const repo = makeRepo(path.join(strayHome, 'git', 'proj'), 'https://github.com/garrytan/gstack');
    fs.mkdirSync(path.join(tmpHome, '.gstack', 'slug-cache'), { recursive: true });
    fs.writeFileSync(cacheFile(repo), 'v2:strayhome');
    expect(resolve(repo).slug).toBe('garrytan-gstack');
    expect(fs.existsSync(path.join(tmpHome, '.gstack', 'slug-cache', 'heal-probed'))).toBe(false);
  });

  test('bash and TS share the sentinel: a hit after either resolver spawns no probe', () => {
    const repo = makeRepo(path.join(fixtures, 'twinproj'));
    expect(resolve(repo).slug).toBe('twinproj');
    expect(resolve(repo, 'ts')).toEqual({ slug: 'twinproj', probes: 2 }); // TS clears it first
    expect(resolve(repo)).toEqual({ slug: 'twinproj', probes: 0 });
    expect(resolve(repo, 'ts')).toEqual({ slug: 'twinproj', probes: 0 });
  });
});
