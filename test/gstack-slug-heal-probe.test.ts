/**
 * gstack-slug's degraded-ancestor heal probe runs once per cache entry while
 * the git configs it reads stay unchanged, not on every cache hit.
 *
 * The probe (bin/gstack-slug section 1b, twin in lib/bin-context.ts) asks git
 * for the project root's origin and then walks for a remote-bearing repo
 * below it: 1-3 git spawns. It fires whenever the cached slug equals the
 * project root's basename and the root has a `.git` entry, which is the
 * steady state of every remoteless repo and every legit #2212 sticky repo.
 * Before this change those projects paid the spawns at every skill start.
 * A sentinel in slug-cache/heal-probed/ now records the entry a probe
 * cleared, with a fingerprint (taken before the probe) of every config the
 * probe reads; a hit trusts it only on an exact match. The entry files keep
 * their "v2:<slug>" format, so older readers parse them unchanged.
 *
 * Git spawns are counted through a PATH shim that logs each invocation and
 * execs the real git (the pattern of test/gstack-slug-parity.test.ts). The
 * same shim can play a second process that runs `git remote add` during a
 * probe (the race case).
 */
import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SLUG_SCRIPT = path.join(ROOT, 'bin', 'gstack-slug');
const BIN_CONTEXT = path.join(ROOT, 'lib', 'bin-context.ts');
const PROBE = 'remote get-url origin';
const ORIGIN = 'https://github.com/garrytan/gstack';
const HEALED = 'garrytan-gstack';
const RESOLVERS = ['bash', 'ts'] as const;
type Via = (typeof RESOLVERS)[number];

// Each test spawns 4-8 resolvers; a loaded host passes the 5 s default.
setDefaultTimeout(60_000);

let tmpHome: string;
let fixtures: string;
let shimDir: string;
let log: string;
let race: string;

beforeEach(() => {
  // realpathSync: macOS tmpdir is a symlink; the scripts key on the physical cwd.
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slug-heal-home-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slug-heal-fix-')));
  shimDir = path.join(fixtures, 'git-shim');
  log = path.join(fixtures, 'git-calls.log');
  race = path.join(fixtures, 'race');
  fs.mkdirSync(shimDir);
  const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
  // When `race` exists (line 1: the probed root, line 2: the repo to change),
  // the 2nd `git -C <root> remote get-url origin` (the last call of the
  // probe's walk) adds an origin to that repo after git answered, then waits
  // 1.1 s so the sentinel lands in a later second than the config (an mtime
  // ordering at bash 3.2's whole seconds cannot hide the race).
  fs.writeFileSync(path.join(shimDir, 'git'), [
    '#!/usr/bin/env bash',
    `echo "$*" >> "${log}"`,
    `"${realGit}" "$@"; rc=$?`,
    `if [[ -f "${race}" ]]; then`,
    `  { IFS= read -r root; IFS= read -r target; } < "${race}"`,
    `  if [[ "$*" == "-C $root ${PROBE}" ]]; then`,
    `    n=$(cat "${race}.n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${race}.n"`,
    `    if [[ $n -eq 2 ]]; then rm -f "${race}"; "${realGit}" -C "$target" remote add origin ${ORIGIN}; sleep 1.1; fi`,
    '  fi',
    'fi',
    'exit $rc',
    '',
  ].join('\n'), { mode: 0o755 });
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
function resolve(cwd: string, via: Via = 'bash'): { slug: string; probes: number } {
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

const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8', timeout: 10_000 });

/** Date a file long ago, as the config of an existing clone is. */
function backdate(file: string): void {
  const past = new Date(Date.now() - 86_400_000);
  fs.utimesSync(file, past, past);
}

/** git init with an optional origin, its config dated long ago. */
function makeRepo(dir: string, originUrl?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', 'main', dir);
  if (originUrl) git('-C', dir, 'remote', 'add', 'origin', originUrl);
  backdate(path.join(dir, '.git', 'config'));
  return dir;
}

/** A stray empty `.git` on an ancestor "home" folder (the 2026-08-17 live bug). */
function strayHome(): string {
  const dir = path.join(fixtures, 'strayhome');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

/** Resolve twice (fresh, then the probe that clears the entry), then once with no probe. */
function settle(cwd: string, via: Via, slug: string): void {
  expect(resolve(cwd, via).slug).toBe(slug);
  expect(resolve(cwd, via).slug).toBe(slug);
  expect(resolve(cwd, via)).toEqual({ slug, probes: 0 });
}

const cacheFile = (dir: string) => path.join(tmpHome, '.gstack', 'slug-cache', path.join(dir, '.git').replace(/\//g, '_'));
const sentinelDir = () => path.join(tmpHome, '.gstack', 'slug-cache', 'heal-probed');

describe('gstack-slug degraded-heal probe is single-shot per cache entry', () => {
  test('remoteless repo: the first cache hit probes, later hits spawn no probe', () => {
    const repo = makeRepo(path.join(fixtures, 'lonely'));
    expect(resolve(repo).slug).toBe('lonely'); // fresh resolve writes the cache
    expect(resolve(repo)).toEqual({ slug: 'lonely', probes: 2 }); // root origin + remote walk
    expect(resolve(repo)).toEqual({ slug: 'lonely', probes: 0 });
    expect(resolve(repo)).toEqual({ slug: 'lonely', probes: 0 });
    // The entry keeps the format older readers parse; the sentinel lives apart.
    expect(fs.readFileSync(cacheFile(repo), 'utf8')).toBe('v2:lonely');
    expect(fs.readdirSync(sentinelDir())).toHaveLength(1);
  });

  test('legit #2212 sticky repo: one probe, then none, and the sticky slug holds', () => {
    const repo = makeRepo(path.join(fixtures, 'stickyproj'), 'https://github.com/x/y.git');
    fs.mkdirSync(path.join(tmpHome, '.gstack', 'slug-cache'), { recursive: true });
    fs.writeFileSync(cacheFile(repo), 'v2:stickyproj');
    expect(resolve(repo)).toEqual({ slug: 'stickyproj', probes: 1 });
    expect(resolve(repo)).toEqual({ slug: 'stickyproj', probes: 0 });
  });

  test('a pre-fix degraded entry still heals on its first hit', () => {
    const repo = makeRepo(path.join(strayHome(), 'git', 'proj'), ORIGIN);
    fs.mkdirSync(path.join(tmpHome, '.gstack', 'slug-cache'), { recursive: true });
    fs.writeFileSync(cacheFile(repo), 'v2:strayhome');
    expect(resolve(repo).slug).toBe(HEALED);
    expect(fs.existsSync(sentinelDir())).toBe(false);
  });

  test('bash and TS share the sentinel: a hit after either resolver spawns no probe', () => {
    const repo = makeRepo(path.join(fixtures, 'twinproj'));
    expect(resolve(repo).slug).toBe('twinproj');
    expect(resolve(repo, 'ts')).toEqual({ slug: 'twinproj', probes: 2 }); // TS clears it first
    expect(resolve(repo)).toEqual({ slug: 'twinproj', probes: 0 });
    expect(resolve(repo, 'ts')).toEqual({ slug: 'twinproj', probes: 0 });
  });

  for (const via of RESOLVERS) {
    test(`${via}: the cwd repo gains a remote after the sentinel, the next hit heals`, () => {
      const repo = makeRepo(path.join(strayHome(), 'git', 'proj'));
      settle(repo, via, 'strayhome'); // no remote anywhere: basename fallback
      git('-C', repo, 'remote', 'add', 'origin', ORIGIN);
      expect(resolve(repo, via).slug).toBe(HEALED);
      expect(fs.readFileSync(cacheFile(repo), 'utf8')).toBe(`v2:${HEALED}`);
    });

    test(`${via}: an intermediate repo gains a remote after the sentinel, the next hit heals`, () => {
      // stray .git > outer repo > inner repo (the cwd): the probe asks outer too.
      const outer = makeRepo(path.join(strayHome(), 'outer'));
      const inner = makeRepo(path.join(outer, 'inner'));
      settle(inner, via, 'strayhome');
      git('-C', outer, 'remote', 'add', 'origin', ORIGIN);
      expect(resolve(inner, via).slug).toBe(HEALED);
    });

    test(`${via}: a .git moved in with an old config mtime, the next hit heals`, () => {
      // mv, cp -a, rsync -a and a backup restore keep the config's old mtime.
      const repo = makeRepo(path.join(strayHome(), 'git', 'proj'));
      const elsewhere = makeRepo(path.join(fixtures, 'elsewhere'), ORIGIN);
      settle(repo, via, 'strayhome');
      fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
      fs.renameSync(path.join(elsewhere, '.git'), path.join(repo, '.git'));
      expect(resolve(repo, via).slug).toBe(HEALED);
    });

    test(`${via}: a sentinel dated in the future (a clock that went back), the next hit heals`, () => {
      const repo = makeRepo(path.join(strayHome(), 'git', 'proj'));
      settle(repo, via, 'strayhome');
      const [sentinel] = fs.readdirSync(sentinelDir());
      const ahead = new Date(Date.now() + 3_600_000);
      fs.utimesSync(path.join(sentinelDir(), sentinel), ahead, ahead);
      git('-C', repo, 'remote', 'add', 'origin', ORIGIN);
      expect(resolve(repo, via).slug).toBe(HEALED);
    });

    test(`${via}: an intermediate linked worktree gains an origin through its main repo, the next hit heals`, () => {
      // outer's .git is a FILE; git reads outer's remote from the main repo's config.
      const main = makeRepo(path.join(fixtures, 'main'));
      git('-C', main, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
      const outer = path.join(strayHome(), 'outer');
      expect(git('-C', main, 'worktree', 'add', '-q', '-b', 'wt', outer).status).toBe(0);
      backdate(path.join(main, '.git', 'config'));
      const inner = makeRepo(path.join(outer, 'inner'));
      settle(inner, via, 'strayhome');
      git('-C', main, 'remote', 'add', 'origin', ORIGIN);
      expect(git('-C', outer, 'remote', 'get-url', 'origin').stdout.trim()).toBe(ORIGIN);
      expect(resolve(inner, via).slug).toBe(HEALED);
    });

    test(`${via}: a remote added while the probe runs is not masked, the next hit heals`, () => {
      const home = strayHome();
      const repo = makeRepo(path.join(home, 'git', 'proj'));
      expect(resolve(repo, via).slug).toBe('strayhome');
      // The shim adds the origin after the walk asked the repo and before the sentinel write.
      fs.writeFileSync(race, `${home}\n${repo}\n`);
      expect(resolve(repo, via).slug).toBe('strayhome');
      expect(fs.existsSync(race)).toBe(false); // the race fired
      expect(git('-C', repo, 'remote', 'get-url', 'origin').stdout.trim()).toBe(ORIGIN);
      expect(resolve(repo, via).slug).toBe(HEALED);
    });
  }
});
