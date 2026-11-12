/**
 * Output paths chosen by a scoped token without the "write" scope.
 *
 * screenshot, pdf and snapshot sit in the read scope and responsive in meta,
 * yet each takes a caller-chosen output path. validateOutputPath allows
 * SAFE_DIRECTORIES, which include the daemon's cwd, so a read-only paired
 * agent could write an image or PDF anywhere in the project. Without "write",
 * the path must stay in TEMP_DIR, the directory GET /file serves to remote
 * agents (TEMP_ONLY in path-security.ts), and out of the project even when
 * the project itself is under TEMP_DIR.
 *
 * The daemon's directories are fixed from process.cwd() at import, so each
 * case runs in a child with a chosen cwd: a project under /var/tmp (outside
 * every temp directory) or a project under TEMP_DIR. The browser stub throws
 * on capture, so nothing is ever written.
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
const READ_ONLY = ['read', 'meta'];
// Each test starts one or more child processes; bun's 5 s default is too short on a loaded host.
const CHILD_TIMEOUT = 60_000;

let root = '';
let project = '';
let tempRoot = '';
let projectInTemp = '';
let linkToProject = '';
let linkToProjectFile = '';

beforeAll(() => {
  if (!POSIX) return;
  root = fs.realpathSync(fs.mkdtempSync('/var/tmp/gstack-output-scope-'));
  project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(project, 'existing.png'), 'x');

  tempRoot = fs.mkdtempSync(path.join(TEMP_DIR, 'gstack-output-scope-'));
  projectInTemp = path.join(tempRoot, 'project');
  fs.mkdirSync(projectInTemp);
  linkToProject = path.join(tempRoot, 'to-project');
  linkToProjectFile = path.join(tempRoot, 'to-project-file.png');
  fs.symlinkSync(project, linkToProject);
  fs.symlinkSync(path.join(project, 'existing.png'), linkToProjectFile);
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

function runChild(script: string, input: unknown, cwd: string): any {
  const r = Bun.spawnSync([process.execPath, '-e', script, JSON.stringify(input)], {
    cwd,
    env: { ...process.env, TMPDIR: path.join(project, 'tmp') },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return JSON.parse(r.stdout.toString().trim().split('\n').pop()!);
}

type Case = { command: string; args: string[]; scopes: string[] | null };

/** Run each command in a child and return the error message each one threw. */
function outcomes(cases: Case[], cwd = project): string[] {
  return runChild(`
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
  `, cases, cwd);
}

/** validateTempOutputPath verdicts in a child: null = allowed, else the error message. */
function tempVerdicts(files: string[], cwd = project): Array<string | null> {
  return runChild(`
    import { validateTempOutputPath } from ${JSON.stringify(PATH_SECURITY)};
    console.log(JSON.stringify(JSON.parse(process.argv[1]).map((f) => {
      try { validateTempOutputPath(f); return null; } catch (e) { return e.message; }
    })));
  `, files, cwd);
}

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
  }, CHILD_TIMEOUT);

  test('follows a symlink under TEMP_DIR into the project and rejects it', () => {
    const [control, inLink, link, linkThenUp, fileLink] = tempVerdicts([
      path.join(tempRoot, 'shot.png'),
      path.join(linkToProject, 'shot.png'),
      linkToProject,
      `${linkToProject}/../x.png`, // raw: path.join would drop link/.. lexically
      linkToProjectFile,
    ]);
    expect(control).toBeNull();
    expect(inLink).toMatch(REJECTED);
    expect(link).toMatch(REJECTED);
    expect(linkThenUp).toMatch(REJECTED);
    expect(fileLink).toMatch(REJECTED);
  }, CHILD_TIMEOUT);

  test('rejects the project when the cwd is inside TEMP_DIR', () => {
    const [bare, absolute, missingDir, nextToProject, defaultPath] = tempVerdicts([
      'shot.png',
      path.join(projectInTemp, 'shot.png'),
      path.join(projectInTemp, 'new-dir', 'shot.png'),
      path.join(tempRoot, 'shot.png'),
      path.join(TEMP_DIR, 'browse-screenshot.png'),
    ], projectInTemp);
    expect(bare).toMatch(REJECTED);
    expect(absolute).toMatch(REJECTED);
    expect(missingDir).toMatch(REJECTED);
    expect(nextToProject).toBeNull();
    expect(defaultPath).toBeNull();
  }, CHILD_TIMEOUT);
});

describe.skipIf(!POSIX)('output paths by token scope', () => {
  test('a read-only token cannot write into the project', () => {
    const results = outcomes([
      { command: 'screenshot', args: [path.join(project, 'shot.png')], scopes: READ_ONLY },
      { command: 'screenshot', args: ['shot.png'], scopes: READ_ONLY },
      { command: 'screenshot', args: ['--viewport', 'out/shot.png'], scopes: READ_ONLY },
      { command: 'screenshot', args: [path.join(linkToProject, 'shot.png')], scopes: READ_ONLY },
      { command: 'pdf', args: [path.join(project, 'page.pdf')], scopes: READ_ONLY },
      { command: 'responsive', args: [path.join(project, 'shot')], scopes: READ_ONLY },
      { command: 'snapshot', args: ['-a', '-o', path.join(project, 'shot.png')], scopes: READ_ONLY },
      { command: 'snapshot', args: ['--heatmap', '{"@e1":"green"}', '--output', 'heat.png'], scopes: READ_ONLY },
    ]);
    for (const result of results) expect(result).toMatch(REJECTED);
  }, CHILD_TIMEOUT);

  test('a read-only token cannot write into a project under TEMP_DIR', () => {
    const results = outcomes([
      { command: 'screenshot', args: ['shot.png'], scopes: READ_ONLY },
      { command: 'screenshot', args: [path.join(projectInTemp, 'shot.png')], scopes: READ_ONLY },
      { command: 'snapshot', args: ['-a', '-o', 'shot.png'], scopes: READ_ONLY },
    ], projectInTemp);
    for (const result of results) expect(result).toMatch(REJECTED);
    expect(outcomes([{ command: 'screenshot', args: [], scopes: READ_ONLY }], projectInTemp))
      .toEqual([REACHED_CAPTURE]);
  }, CHILD_TIMEOUT);

  test('a read-only token keeps the default path and TEMP_DIR', () => {
    expect(outcomes([
      { command: 'screenshot', args: [], scopes: READ_ONLY },
      { command: 'screenshot', args: [path.join(TEMP_DIR, 'shot.png')], scopes: READ_ONLY },
      { command: 'pdf', args: [path.join(TEMP_DIR, 'page.pdf')], scopes: READ_ONLY },
      { command: 'snapshot', args: ['-a', '-o', path.join(TEMP_DIR, 'shot.png')], scopes: READ_ONLY },
      { command: 'snapshot', args: ['-a'], scopes: READ_ONLY },
    ])).toEqual([REACHED_CAPTURE, REACHED_CAPTURE, REACHED_CAPTURE, REACHED_CAPTURE, REACHED_CAPTURE]);
  }, CHILD_TIMEOUT);

  test('a write-scoped token and the local caller keep the cwd', () => {
    expect(outcomes([
      { command: 'screenshot', args: [path.join(project, 'shot.png')], scopes: ['read', 'write'] },
      { command: 'screenshot', args: ['shot.png'], scopes: null },
      { command: 'pdf', args: [path.join(project, 'page.pdf')], scopes: null },
      { command: 'snapshot', args: ['-a', '-o', path.join(project, 'shot.png')], scopes: ['read', 'write'] },
      { command: 'snapshot', args: ['-a', '-o', 'shot.png'], scopes: null },
    ])).toEqual([REACHED_CAPTURE, REACHED_CAPTURE, REACHED_CAPTURE, REACHED_CAPTURE, REACHED_CAPTURE]);
  }, CHILD_TIMEOUT);
});
