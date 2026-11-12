import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// setup's "bun is not installed" hint used to say "Install with checksum
// verification" and then print an echo with no expected hash, followed by a
// line that ran the downloaded script regardless. The hint now comes from
// gstack_bun_install_hint (bin/gstack-bun-version.sh): the exact release
// archive, checked against the SHA-256 gstack pins for the target, or against
// the release's SHASUMS256.txt where gstack pins none, and installed only when
// the check passes. On Linux the target follows the host the way
// bun.sh/install picks it: -baseline without AVX2, -musl on musl libc. These
// tests run the printed recipe with a fake curl.

const ROOT = path.resolve(import.meta.dir, '..');
const VERSIONS = path.join(ROOT, 'bin', 'gstack-bun-version.sh');
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const sh = (script: string, env: Record<string, string> = {}) =>
  spawnSync('/bin/bash', ['-c', `. "${VERSIONS}" && ${script}`], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env } });
const tested = sh('printf %s "$GSTACK_BUN_TESTED"').stdout;
type Host = { avx2?: boolean; libc?: 'glibc' | 'musl' };
/** The hint for UNAME_MS on a Linux host with these CPU flags and this libc. */
const hint = (unameMs: string, { avx2 = true, libc = 'glibc' }: Host = {}) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-cpu-'));
  bases.push(base);
  const cpuinfo = path.join(base, 'cpuinfo');
  fs.writeFileSync(cpuinfo, `processor\t: 0\nflags\t\t: fpu sse sse2 ${avx2 ? 'avx avx2 ' : ''}bmi1\n`);
  const r = sh(`gstack_bun_install_hint "${unameMs}" "${cpuinfo}" ${libc}`);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
};
/** Every 64-hex string in a hint must be the pin of the target it prints. */
const expectOnlyPinOf = (text: string, target: string) => {
  const pinned = sh(`gstack_bun_archive_sha256 ${target}`).stdout.trim();
  expect(pinned).toMatch(/^[0-9a-f]{64}$/);
  expect(text.match(/[0-9a-f]{64}/g)).toEqual([pinned]);
};
/** The indented recipe lines of a hint, as one script. */
const recipe = (text: string) => text.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.slice(2)).join('\n');
const hasTools = ['zip', 'unzip'].every((t) => spawnSync('bash', ['-c', `command -v ${t}`]).status === 0);

/**
 * Runs a recipe under a fake curl that serves `zip` for the archive URL and
 * `sums` for SHASUMS256.txt. Returns the output and whether bun was installed.
 */
function runRecipe(script: string, zip: Buffer, sums: string) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-recipe-'));
  bases.push(base);
  const fake = path.join(base, 'fakebin');
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(base, 'archive.zip'), zip);
  fs.writeFileSync(path.join(base, 'SHASUMS256.txt'), sums);
  fs.writeFileSync(path.join(fake, 'curl'), `#!/bin/bash
url=""; out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
echo "$url" >> "${base}/urls"
case "$url" in
  */SHASUMS256.txt) cp "${base}/SHASUMS256.txt" "$out" ;;
  *.zip) cp "${base}/archive.zip" "$out" ;;
  *) exit 22 ;;
esac
`, { mode: 0o755 });
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 30_000,
    env: { PATH: `${fake}:${process.env.PATH}`, HOME: home, TMPDIR: base },
  });
  const urls = fs.existsSync(path.join(base, 'urls')) ? fs.readFileSync(path.join(base, 'urls'), 'utf8') : '';
  return { out: r.stdout + r.stderr, installed: fs.existsSync(path.join(home, '.bun', 'bin', 'bun')), urls };
}

/**
 * A real zip holding bun-<target>/bun, the layout of a Bun release archive.
 * The fake bun prints the tested version, or runs BODY (a binary that cannot
 * start on the host: `exit 127`).
 */
function bunZip(target: string, body = `echo ${tested}`): Buffer {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-zip-'));
  bases.push(base);
  fs.mkdirSync(path.join(base, `bun-${target}`));
  fs.writeFileSync(path.join(base, `bun-${target}`, 'bun'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const r = spawnSync('zip', ['-qr', 'bun.zip', `bun-${target}`], { cwd: base, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return fs.readFileSync(path.join(base, 'bun.zip'));
}
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('gstack_bun_install_hint', () => {
  test('a pinned glibc Linux target prints the pin of that target and a check that gates the install', () => {
    const cases: [string, Host, string][] = [
      ['Linux x86_64', { avx2: true }, 'linux-x64'],
      ['Linux x86_64', { avx2: false }, 'linux-x64-baseline'],
      ['Linux aarch64', {}, 'linux-aarch64'],
      ['Linux arm64', { avx2: false }, 'linux-aarch64'],
    ];
    for (const [uname, host, target] of cases) {
      const text = hint(uname, host);
      expect(text).toContain(`BUN_VERSION="${tested}" target="${target}"`);
      expectOnlyPinOf(text, target);
      expect(text).toMatch(/[0-9a-f]{64} {2}bun-\$target\.zip" \| .+ -c -\) \\\n {4}&& unzip/);
      expect(text).not.toContain('SHASUMS256.txt"');
      expect(text).not.toContain('AVX2');
    }
  });

  test('musl Linux selects the -musl archive and checks it against the release SHASUMS256.txt', () => {
    const cases: [string, Host, string][] = [
      ['Linux x86_64', { libc: 'musl', avx2: true }, 'linux-x64-musl'],
      ['Linux x86_64', { libc: 'musl', avx2: false }, 'linux-x64-musl-baseline'],
      ['Linux aarch64', { libc: 'musl' }, 'linux-aarch64-musl'],
    ];
    for (const [uname, host, target] of cases) {
      const text = hint(uname, host);
      expect(text).toContain(`BUN_VERSION="${tested}" target="${target}"`);
      expect(text).toContain(`gstack pins no hash for ${target}`);
      expect(text).toContain('curl -fsSL "$url/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"');
      expect(text).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  test('gstack_bun_libc: alpine-release, the musl loader or a musl ldd mean musl; otherwise glibc', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-root-'));
    bases.push(base);
    const fake = path.join(base, 'fakebin');
    fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, 'ldd'), '#!/bin/sh\necho "ldd (GNU libc) 2.39"\n', { mode: 0o755 });
    const libc = (root: string, ldd = true) =>
      sh(`gstack_bun_libc "${root}"`, { PATH: ldd ? `${fake}:${process.env.PATH}` : (process.env.PATH ?? '') }).stdout.trim();
    const root = (files: string[]) => {
      const r = fs.mkdtempSync(path.join(base, 'r-'));
      for (const f of files) { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), ''); }
      return r;
    };
    expect(libc(root(['etc/alpine-release']))).toBe('musl');
    // A musl image with no alpine-release and no working ldd (busybox:musl).
    expect(libc(root(['lib/ld-musl-aarch64.so.1']))).toBe('musl');
    expect(libc(root(['lib/ld-musl-x86_64.so.1']), false)).toBe('musl');
    expect(libc(root(['lib/ld-linux-aarch64.so.1']))).toBe('glibc');
    expect(libc(root([]))).toBe('glibc');
  });

  test('without a libc argument, an ldd that reports musl selects the -musl archive', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-ldd-'));
    bases.push(base);
    fs.writeFileSync(path.join(base, 'ldd'), '#!/bin/sh\necho "musl libc (x86_64)" >&2\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(base, 'cpuinfo'), 'flags\t\t: avx2\n');
    const r = sh(`gstack_bun_install_hint "Linux x86_64" "${base}/cpuinfo"`, { PATH: `${base}:${process.env.PATH}` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('target="linux-x64-musl"');
  });

  test('a target gstack pins no hash for is checked against the release SHASUMS256.txt, and says so', () => {
    for (const [uname, target] of [['Darwin arm64', 'darwin-aarch64'], ['Darwin x86_64', 'darwin-x64']]) {
      const text = hint(uname);
      expect(text).toContain(`BUN_VERSION="${tested}" target="${target}"`);
      expect(text).toContain(`gstack pins no hash for ${target}`);
      expect(text).toContain('url="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"');
      expect(text).toContain('curl -fsSL "$url/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"');
      // A missing row must stop the chain: grep writes a file and its exit
      // status gates the check (macOS /sbin/sha256sum -c passes empty input).
      expect(text).toMatch(/grep " bun-\$target\.zip\\\$" SHASUMS256\.txt > bun\.sha256 && .+ -c bun\.sha256\) \\\n {4}&& unzip/);
    }
  });

  test('an unknown platform claims no checksum and points to the Bun docs', () => {
    const text = hint('FreeBSD amd64');
    expect(text).not.toMatch(/checksum|SHA-256|sha256/i);
    expect(text).toContain('https://bun.sh/docs/installation');
    expect(text).toContain(tested);
  });

  test('pinned recipe: an archive that does not match the pin is never installed', () => {
    const r = runRecipe(recipe(hint('Linux x86_64')), Buffer.from('not the bun archive'), '');
    expect(r.urls).toContain(`/bun-v${tested}/bun-linux-x64.zip`);
    expect(r.out).toMatch(/FAILED|did NOT match/);
    expect(r.installed).toBe(false);
  });

  test('musl targets name the Alpine prerequisite above the recipe; glibc and macOS do not', () => {
    for (const [uname, host] of [['Linux x86_64', { libc: 'musl' }], ['Linux aarch64', { libc: 'musl' }]] as [string, Host][]) {
      const text = hint(uname, host);
      expect(text.split('\n')[1]).toBe('On Alpine, first install the libraries Bun needs: apk add libstdc++ libgcc');
      expect(recipe(text)).not.toContain('apk');
    }
    for (const text of [hint('Linux x86_64'), hint('Darwin arm64')]) expect(text).not.toContain('apk');
  });

  test.skipIf(!hasTools)('a verified archive whose bun does not run, or reports another version, is never installed', () => {
    for (const body of ['exit 127', 'echo 1.4.1']) {
      const zip = bunZip('linux-aarch64-musl', body);
      const r = runRecipe(recipe(hint('Linux aarch64', { libc: 'musl' })), zip, `${sha256(zip)}  bun-linux-aarch64-musl.zip\n`);
      expect(r.out).toContain('bun-linux-aarch64-musl.zip: OK');
      expect(r.out).toContain(`the downloaded bun does not report ${tested} on this machine; nothing installed`);
      expect(r.out).not.toContain('bun installed');
      expect(r.installed).toBe(false);
    }
  });

  test.skipIf(!hasTools)('musl recipe: installs the -musl archive on a SHASUMS256.txt match', () => {
    const zip = bunZip('linux-x64-musl-baseline');
    const r = runRecipe(recipe(hint('Linux x86_64', { libc: 'musl', avx2: false })), zip, `${sha256(zip)}  bun-linux-x64-musl-baseline.zip\n`);
    expect(r.urls).toContain(`/bun-v${tested}/bun-linux-x64-musl-baseline.zip`);
    expect(r.out).toContain('bun-linux-x64-musl-baseline.zip: OK');
    expect(r.installed).toBe(true);
  });

  test.skipIf(!hasTools)('SHASUMS256 recipe: installs on a match, refuses a mismatch and a missing row', () => {
    const zip = bunZip('darwin-aarch64');
    const script = recipe(hint('Darwin arm64'));
    const ok = runRecipe(script, zip, `${sha256(zip)}  bun-darwin-aarch64.zip\n`);
    expect(ok.urls).toContain(`/bun-v${tested}/SHASUMS256.txt`);
    expect(ok.out).toContain('bun-darwin-aarch64.zip: OK');
    expect(ok.installed).toBe(true);

    const bad = runRecipe(script, zip, `${'0'.repeat(64)}  bun-darwin-aarch64.zip\n`);
    expect(bad.out).toMatch(/FAILED|did NOT match/);
    expect(bad.installed).toBe(false);

    const missing = runRecipe(script, zip, `${sha256(zip)}  bun-linux-x64.zip\n`);
    expect(missing.out).not.toContain('bun installed');
    expect(missing.installed).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('setup prints the hint for this machine when bun is missing', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-hint-'));
    bases.push(base);
    const nobun = path.join(base, 'bin');
    fs.mkdirSync(nobun);
    // grep and ldd too, so setup and the expected value run the real default
    // detection (/proc/cpuinfo, the libc) of this machine.
    for (const tool of ['dirname', 'cat', 'uname', 'mkdir', 'grep', 'ldd']) {
      const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf-8', timeout: 10_000 }).stdout.trim();
      if (found) fs.symlinkSync(found, path.join(nobun, tool));
    }
    const r = spawnSync('/bin/bash', [path.join(ROOT, 'setup')], { encoding: 'utf-8', env: { PATH: nobun, HOME: base }, timeout: 30_000 });
    expect(r.status).toBe(1);
    const unameMs = spawnSync('uname', ['-ms'], { encoding: 'utf8' }).stdout.trim();
    expect(r.stderr).toBe(`Error: bun is required but not installed.\n${sh(`gstack_bun_install_hint "${unameMs}"`, { PATH: nobun }).stdout}`);
  });
});
