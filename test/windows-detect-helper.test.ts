/**
 * bin/gstack-windows-detect.sh: one sourced IS_WINDOWS detection for setup,
 * bin/gstack-memorable and bin/gstack-gbrain-install (TODOS.md D24).
 *
 * Each caller used to carry its own copy of the `uname -s` case block. The
 * no-behavior-change proof: for every uname value, the caller's CURRENT
 * IS_WINDOWS line (sliced from its source, run with the helper sourced) prints
 * what the block it replaced printed. A `uname` shim on PATH supplies the value,
 * so the Windows branch runs on any host.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const HELPER = path.join(ROOT, 'bin', 'gstack-windows-detect.sh');

// The copies the callers carried at f1cbdbb, verbatim except for the case subject.
const OLD_BLOCK = (subject: string) =>
  `IS_WINDOWS=0\ncase "${subject}" in\n  MINGW*|MSYS*|CYGWIN*|Windows_NT) IS_WINDOWS=1 ;;\nesac`;
const OLD_PLAIN = OLD_BLOCK('$(uname -s)');
const OLD_MEMORABLE = OLD_BLOCK('${GSTACK_MEMORABLE_TEST_UNAME:-$(uname -s)}');

const CALLERS = [
  { file: 'setup', sourceLine: '. "$SOURCE_GSTACK_DIR/bin/gstack-windows-detect.sh" ||', old: OLD_PLAIN },
  { file: 'bin/gstack-memorable', sourceLine: '. "$(dirname "$0")/gstack-windows-detect.sh" ||', old: OLD_MEMORABLE },
  { file: 'bin/gstack-gbrain-install', sourceLine: '. "$(dirname "$0")/gstack-windows-detect.sh" ||', old: OLD_PLAIN },
];

const UNAMES = ['Darwin', 'Linux', 'MINGW64_NT-10.0', 'MINGW32_NT-6.1', 'MSYS_NT-10.0', 'CYGWIN_NT-10.0', 'Windows_NT', 'FreeBSD', 'Plan9'];

let tmp: string;
let shimDir: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-windetect-'));
  shimDir = path.join(tmp, 'shim');
  fs.mkdirSync(shimDir);
  fs.writeFileSync(path.join(shimDir, 'uname'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$GSTACK_TEST_UNAME"\n', { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run `body` under bash -u with the uname shim first on PATH; returns stdout. */
function run(body: string, uname: string, extraEnv: Record<string, string> = {}, helper = HELPER): string {
  const r = spawnSync('bash', ['-c', `set -u\n. "$1" || exit 9\n${body}\nprintf '%s' "$IS_WINDOWS"`, '_', helper.replace(/\\/g, '/')], {
    env: { PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`, GSTACK_TEST_UNAME: uname, ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
  });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return r.stdout;
}

function currentLine(file: string): string {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  const lines = src.split('\n').filter((l) => /^\s*IS_WINDOWS="\$\(gstack_windows_flag\b/.test(l));
  expect(lines).toHaveLength(1);
  return lines[0]!.trim();
}

describe('gstack_windows_flag', () => {
  test('the shim reaches uname (control: a shim that is not used would make every row Darwin or Linux)', () => {
    expect(run('IS_WINDOWS="$(uname -s)"', 'MSYS_NT-10.0')).toBe('MSYS_NT-10.0');
  });

  test('an explicit argument wins over uname; an empty one falls back to uname', () => {
    expect(run('IS_WINDOWS="$(gstack_windows_flag CYGWIN_NT-10.0)"', 'Darwin')).toBe('1');
    expect(run('IS_WINDOWS="$(gstack_windows_flag Linux)"', 'MINGW64_NT-10.0')).toBe('0');
    expect(run('IS_WINDOWS="$(gstack_windows_flag "")"', 'MINGW64_NT-10.0')).toBe('1');
  });

  test('sourced from a directory whose path has spaces', () => {
    const spaced = path.join(tmp, 'install dir with spaces', 'bin');
    fs.mkdirSync(spaced, { recursive: true });
    const copy = path.join(spaced, 'gstack-windows-detect.sh');
    fs.copyFileSync(HELPER, copy);
    expect(run('IS_WINDOWS="$(gstack_windows_flag)"', 'MINGW64_NT-10.0', {}, copy)).toBe('1');
    expect(run('IS_WINDOWS="$(gstack_windows_flag)"', 'Darwin', {}, copy)).toBe('0');
  });
});

describe('callers: same IS_WINDOWS as the block each one replaced', () => {
  for (const caller of CALLERS) {
    describe(caller.file, () => {
      test('sources the helper and carries no copy of the case block', () => {
        const src = fs.readFileSync(path.join(ROOT, caller.file), 'utf-8');
        expect(src).toContain(caller.sourceLine);
        expect(src).not.toContain('MINGW*|MSYS*|CYGWIN*|Windows_NT)');
        expect(src).not.toContain('TODO D24');
      });

      for (const uname of UNAMES) {
        test(`uname ${uname}`, () => {
          const before = run(caller.old, uname);
          const after = run(currentLine(caller.file), uname);
          expect(after).toBe(before);
          expect(after).toBe(/^(MINGW|MSYS|CYGWIN)|^Windows_NT$/.test(uname) ? '1' : '0');
        });
      }
    });
  }

  describe('bin/gstack-memorable test override GSTACK_MEMORABLE_TEST_UNAME', () => {
    const cases: Array<[string, string]> = [
      ['MINGW64_NT-10.0', 'Darwin'],
      ['Linux', 'MINGW64_NT-10.0'],
      ['', 'CYGWIN_NT-10.0'],
      ['', 'Darwin'],
    ];
    for (const [override, uname] of cases) {
      test(`override '${override}' over uname ${uname}`, () => {
        const env = { GSTACK_MEMORABLE_TEST_UNAME: override };
        const before = run(OLD_MEMORABLE, uname, env);
        const after = run(currentLine('bin/gstack-memorable'), uname, env);
        expect(after).toBe(before);
      });
    }

    test('unset override reads uname (set -u safe)', () => {
      expect(run(currentLine('bin/gstack-memorable'), 'MSYS_NT-10.0')).toBe('1');
      expect(run(OLD_MEMORABLE, 'MSYS_NT-10.0')).toBe('1');
    });
  });
});
