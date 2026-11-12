/**
 * Output paths chosen by a scoped token without the "write" scope.
 *
 * screenshot and pdf sit in the read scope and responsive in meta, yet each
 * takes a caller-chosen output path. validateOutputPath allows
 * SAFE_DIRECTORIES, which include the daemon's cwd, so a read-only paired
 * agent could write an image or PDF anywhere in the project. Without "write",
 * the path must stay in TEMP_DIR, the directory GET /file serves to remote
 * agents (TEMP_ONLY in path-security.ts).
 *
 * SAFE_DIRECTORIES is fixed from process.cwd() at import, and a checkout under
 * /tmp would put the project inside TEMP_DIR. So the commands run in a child
 * whose cwd is a project dir under /var/tmp, outside every temp directory.
 * The browser stub throws on capture, so nothing is ever written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TEMP_DIR } from '../src/platform';

const META_COMMANDS = path.resolve(import.meta.dir, '../src/meta-commands.ts');
const PATH_SECURITY = path.resolve(import.meta.dir, '../src/path-security.ts');
const POSIX = process.platform !== 'win32' && fs.existsSync('/var/tmp');
const REACHED_CAPTURE = 'reached capture';
const REJECTED = /Path must be within/;

let root = '';
let project = '';

beforeAll(() => {
  if (!POSIX) return;
  root = fs.realpathSync(fs.mkdtempSync('/var/tmp/gstack-output-scope-'));
  project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'tmp'), { recursive: true });
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

type Case = { command: string; args: string[]; scopes: string[] | null };

/** Run each case in a child (cwd = project) and return the error message each one threw. */
function outcomes(cases: Case[]): string[] {
  const script = `
    import { handleMetaCommand } from ${JSON.stringify(META_COMMANDS)};
    const capture = () => { throw new Error(${JSON.stringify(REACHED_CAPTURE)}); };
    const bm = {
      getPage: () => ({ pdf: capture, viewportSize: () => null, setViewportSize: capture }),
      getActiveSession: () => ({ getDevice: () => null, getPage: capture }),
    };
    const token = (scopes) => scopes && ({
      token: 'gsk_sess_test', clientId: 'remote-agent', type: 'session', scopes,
      tabPolicy: 'own-only', rateLimit: 0, expiresAt: null,
      createdAt: new Date().toISOString(), commandCount: 0,
    });
    const out = [];
    for (const c of JSON.parse(process.argv[1])) {
      try { await handleMetaCommand(c.command, c.args, bm, () => {}, token(c.scopes)); out.push('no error'); }
      catch (e) { out.push(e.message); }
    }
    console.log(JSON.stringify(out));
  `;
  const r = Bun.spawnSync([process.execPath, '-e', script, JSON.stringify(cases)], {
    cwd: project,
    env: { ...process.env, TMPDIR: path.join(project, 'tmp') },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return JSON.parse(r.stdout.toString().trim().split('\n').pop()!);
}

function tempVerdicts(files: string[]): Array<string | null> {
  const script = `
    import { validateTempOutputPath } from ${JSON.stringify(PATH_SECURITY)};
    console.log(JSON.stringify(JSON.parse(process.argv[1]).map((f) => {
      try { validateTempOutputPath(f); return null; } catch (e) { return e.message; }
    })));
  `;
  const r = Bun.spawnSync([process.execPath, '-e', script, JSON.stringify(files)], {
    cwd: project, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
  });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return JSON.parse(r.stdout.toString().trim().split('\n').pop()!);
}

const READ_ONLY = ['read', 'meta'];

describe.skipIf(!POSIX)('validateTempOutputPath', () => {
  test('allows TEMP_DIR, rejects the cwd and traversal out of TEMP_DIR', () => {
    const [temp, cwd, relative, traversal] = tempVerdicts([
      path.join(TEMP_DIR, 'shot.png'),
      path.join(project, 'shot.png'),
      'shot.png',
      path.join(TEMP_DIR, '..', 'etc', 'shot.png'),
    ]);
    expect(temp).toBeNull();
    expect(cwd).toMatch(REJECTED);
    expect(relative).toMatch(REJECTED);
    expect(traversal).toMatch(REJECTED);
  });
});

describe.skipIf(!POSIX)('output paths by token scope', () => {
  test('a read-only token cannot write into the project', () => {
    const results = outcomes([
      { command: 'screenshot', args: [path.join(project, 'shot.png')], scopes: READ_ONLY },
      { command: 'screenshot', args: ['shot.png'], scopes: READ_ONLY },
      { command: 'screenshot', args: ['--viewport', 'out/shot.png'], scopes: READ_ONLY },
      { command: 'pdf', args: [path.join(project, 'page.pdf')], scopes: READ_ONLY },
      { command: 'responsive', args: [path.join(project, 'shot')], scopes: READ_ONLY },
    ]);
    for (const result of results) expect(result).toMatch(REJECTED);
  });

  test('a read-only token keeps the default path and TEMP_DIR', () => {
    expect(outcomes([
      { command: 'screenshot', args: [], scopes: READ_ONLY },
      { command: 'screenshot', args: [path.join(TEMP_DIR, 'shot.png')], scopes: READ_ONLY },
      { command: 'pdf', args: [path.join(TEMP_DIR, 'page.pdf')], scopes: READ_ONLY },
    ])).toEqual([REACHED_CAPTURE, REACHED_CAPTURE, REACHED_CAPTURE]);
  });

  test('a write-scoped token and the local caller keep the cwd', () => {
    expect(outcomes([
      { command: 'screenshot', args: [path.join(project, 'shot.png')], scopes: ['read', 'write'] },
      { command: 'screenshot', args: ['shot.png'], scopes: null },
      { command: 'pdf', args: [path.join(project, 'page.pdf')], scopes: null },
    ])).toEqual([REACHED_CAPTURE, REACHED_CAPTURE, REACHED_CAPTURE]);
  });
});
