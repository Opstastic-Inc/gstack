/**
 * file: navigation for scoped tokens (paired agents, skill spawns) is held to
 * the temp directory, the same rule GET /file applies. Without it a paired
 * agent ran `goto file://./.env` (any file under the daemon's cwd passes the
 * local safe-dirs rule) and then `text` returned the file's content.
 *
 * Drives the real POST /command pipeline through buildFetchHandler, over both
 * listeners, in a child process whose cwd is a project directory outside
 * TEMP_DIR (the safe directories are fixed at import from process.cwd(), and a
 * checkout under /tmp would make every project file a temp file). The module's
 * BrowserManager, the one command dispatch uses, records each navigation
 * instead of driving Chromium.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEMP_DIR } from '../src/platform';

type Step = { status: number; error?: string; navigations: string[] };
let project = '';
let tempFile = '';
let steps: Record<string, Step> = {};
let unit: Record<string, string> = {};

const src = (rel: string) => JSON.stringify(path.resolve(import.meta.dir, rel));

const SCRIPT = (resultsFile: string, tempFile: string) => `
import { __testInternals__ } from ${src('../src/server.ts')};
import { validateNavigationUrl } from ${src('../src/url-validation.ts')};
import { makeServer } from ${src('route-test-harness.ts')};

const navigations = [];
const page = {
  goto: async (url) => { navigations.push(url); return { status: () => 200 }; },
  url: () => 'about:blank',
};
const session = { getPage: () => page, getActiveFrameOrPage: () => page, getFrame: () => null, clearLoadedHtml: () => {} };
Object.assign(__testInternals__.browserManager, {
  getActiveTabId: () => 1,
  checkTabAccess: () => true,
  newTab: async (url) => { if (url) navigations.push(url); return 2; },
  isWatching: () => false,
  getCurrentUrl: () => 'about:blank',
  getTabCount: () => 1,
  ensureCommandTab: async () => undefined,
  getActiveSession: () => session,
  failIfNavigationBlocked: (_page, result) => result,
});

const outcome = (p) => p.then(() => 'resolved', (err) => 'rejected: ' + err.message);
const unit = {
  default: await outcome(validateNavigationUrl('file://./.env')),
  tempOnly: await outcome(validateNavigationUrl('file://./.env', { fileAccess: 'temp-only' })),
};

const server = makeServer();
const scoped = server.scopedToken('remote-agent');
const steps = {};
const run = async (name, listener, token, body) => {
  navigations.length = 0;
  const resp = await server[listener]('/command', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let error;
  try { error = JSON.parse(text).error; } catch {}
  steps[name] = { status: resp.status, error, navigations: [...navigations] };
};
for (const listener of ['tunnel', 'local']) {
  await run(listener + '-goto-rel', listener, scoped, { command: 'goto', args: ['file://./.env'] });
  await run(listener + '-goto-abs', listener, scoped, { command: 'goto', args: ['file://' + process.cwd() + '/.env'] });
  await run(listener + '-newtab', listener, scoped, { command: 'newtab', args: ['file://./.env'] });
  await run(listener + '-goto-temp', listener, scoped, { command: 'goto', args: ['file://' + ${JSON.stringify(tempFile)}] });
}
await run('root-goto-rel', 'local', server.rootToken, { command: 'goto', args: ['file://./.env'] });
server.cleanup();
await Bun.write(${JSON.stringify(resultsFile)}, JSON.stringify({ unit, steps }));
process.exit(0);
`;

beforeAll(() => {
  // Under the home folder, not the temp dirs: the project must sit outside TEMP_DIR.
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), 'browse-scoped-nav-')));
  fs.writeFileSync(path.join(project, '.env'), 'API_KEY=not-a-real-key\n');
  tempFile = path.join(TEMP_DIR, `browse-scoped-nav-${process.pid}.html`);
  fs.writeFileSync(tempFile, '<html><body>ok</body></html>');
  const resultsFile = path.join(project, 'results.json');
  fs.writeFileSync(path.join(project, 'drive.ts'), SCRIPT(resultsFile, tempFile));
  const r = spawnSync(process.execPath, [path.join(project, 'drive.ts')], {
    cwd: project, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, GSTACK_HOME: path.join(project, 'state'), BROWSE_STATE_FILE: path.join(project, 'state', 'browse.json'), BROWSE_PARENT_PID: '0' },
  });
  if (!fs.existsSync(resultsFile)) throw new Error(`driver failed (${r.status}): ${r.stderr.slice(-2000)}`);
  ({ unit, steps } = JSON.parse(fs.readFileSync(resultsFile, 'utf8')));
}, 90_000);

afterAll(() => {
  if (project) fs.rmSync(project, { recursive: true, force: true });
  if (tempFile) fs.rmSync(tempFile, { force: true });
});

describe('file: navigation for scoped tokens', () => {
  test("validateNavigationUrl: 'temp-only' refuses a project file the default rule opens", () => {
    expect(unit.default).toBe('resolved');
    expect(unit.tempOnly).toMatch(/^rejected: Path must be within/);
  });

  test('a scoped token cannot open a project file, over the tunnel or the local listener', () => {
    for (const listener of ['tunnel', 'local']) {
      for (const name of ['goto-rel', 'goto-abs', 'newtab']) {
        const step = steps[`${listener}-${name}`];
        expect(step.status).toBe(403);
        expect(step.error).toMatch(/^Path must be within/);
        expect(step.navigations).toEqual([]);
      }
    }
  });

  test('a scoped token can open a file in the temp directory', () => {
    for (const listener of ['tunnel', 'local']) {
      const step = steps[`${listener}-goto-temp`];
      expect(step.status).toBe(200);
      expect(step.navigations).toHaveLength(1);
      expect(step.navigations[0]).toContain(path.basename(tempFile));
    }
  });

  test('the root token (local CLI) still opens a project file', () => {
    expect(steps['root-goto-rel'].status).toBe(200);
    expect(steps['root-goto-rel'].navigations).toEqual([pathToFileURL(path.join(project, '.env')).href]);
  });
});
