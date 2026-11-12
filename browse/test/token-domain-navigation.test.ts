/**
 * A scoped token's `domains` limit applies to every top-frame navigation of
 * the tab the token drives, not only to the `goto` / `newtab` argument.
 * Before this, server.ts checked args[0] once, so a token limited to
 * 127.0.0.1 reached localhost through a 302, a link click or a script.
 *
 * Runs the real command dispatch (server.ts handleCommandInternal on the
 * module's own BrowserManager) in a child process, so the module-level
 * server state never touches this test process. 127.0.0.1 is the allowed
 * domain and localhost is the foreign one: both reach the same fixture.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Step = { status: number; result: string; url: string };
let dir = '';
let port = 0;
let steps: Record<string, Step> = {};

const SCRIPT = (root: string) => `
import { __testInternals__ } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/server.ts'))};
import { createToken } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/token-registry.ts'))};
const html = (body) => new Response('<!doctype html><html><body>' + body + '</body></html>', { headers: { 'Content-Type': 'text/html' } });
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const allowed = 'http://127.0.0.1:' + server.port;
    const foreign = 'http://localhost:' + server.port;
    if (url.pathname === '/to-foreign') return Response.redirect(foreign + '/landed', 302);
    if (url.pathname === '/to-same') return Response.redirect(allowed + '/landed', 302);
    if (url.pathname === '/link') return html('<a id="go" href="' + foreign + '/landed">go</a>');
    if (url.pathname === '/script') return html('<button id="go" onclick="location.href=\\'' + foreign + '/landed\\'">go</button>');
    return html('<p id="ok">' + url.host + url.pathname + '</p>');
  },
});
const allowed = 'http://127.0.0.1:' + server.port;
const bm = __testInternals__.browserManager;
const limited = createToken({ clientId: 'agent-limited', scopes: ['read', 'write'], domains: ['127.0.0.1'], tabPolicy: 'shared', rateLimit: 0 });
const ownOnly = createToken({ clientId: 'agent-own-only', scopes: ['read', 'write'], domains: ['127.0.0.1'], tabPolicy: 'own-only', rateLimit: 0 });
const unlimited = createToken({ clientId: 'agent-unlimited', scopes: ['read', 'write'], tabPolicy: 'shared', rateLimit: 0 });
const steps = {};
const record = async (name, token, command, args, tabId) => {
  const body = tabId === undefined ? { command, args } : { command, args, tabId };
  const r = await __testInternals__.handleCommandInternal(body, token);
  const page = tabId === undefined ? bm.getPage() : bm.getPageForTab(tabId);
  steps[name] = { status: r.status, result: String(r.result), url: page ? page.url() : '' };
  return r;
};
await bm.launch();
await record('goto-allowed', limited, 'goto', [allowed + '/start']);
await record('redirect-foreign', limited, 'goto', [allowed + '/to-foreign']);
await record('redirect-same', limited, 'goto', [allowed + '/to-same']);
await record('link-page', limited, 'goto', [allowed + '/link']);
await record('link-foreign', limited, 'click', ['#go']);
await record('script-page', limited, 'goto', [allowed + '/script']);
await record('script-foreign', limited, 'click', ['#go']);
await record('unlimited-redirect', unlimited, 'goto', [allowed + '/to-foreign']);
await record('root-redirect', null, 'goto', [allowed + '/to-foreign']);
await record('root-after-limited', null, 'goto', [allowed + '/to-same']);
await record('root-after-limited-foreign', null, 'goto', [allowed + '/to-foreign']);
const tab = await record('own-only-newtab', ownOnly, 'newtab', []);
const tabId = JSON.parse(tab.result).tabId;
await record('own-only-redirect', ownOnly, 'goto', [allowed + '/to-foreign'], tabId);
await Bun.write(${JSON.stringify(path.join(root, 'steps.json'))}, JSON.stringify({ port: server.port, steps }));
server.stop(true);
await Promise.race([bm.close(), Bun.sleep(3000)]);
process.exit(0);
`;

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browse-token-domains-')));
  fs.writeFileSync(path.join(dir, 'drive.ts'), SCRIPT(dir));
  const r = spawnSync(process.execPath, [path.join(dir, 'drive.ts')], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, GSTACK_HOME: path.join(dir, 'state'), CHROMIUM_PROFILE: path.join(dir, 'profile'),
      BROWSE_STATE_FILE: path.join(dir, 'state', 'browse.json'), BROWSE_PARENT_PID: '0' },
  });
  if (!fs.existsSync(path.join(dir, 'steps.json'))) throw new Error(`driver failed (${r.status}): ${r.stderr.slice(-2000)}`);
  ({ port, steps } = JSON.parse(fs.readFileSync(path.join(dir, 'steps.json'), 'utf8')));
}, 150_000);
afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const allowedUrl = (p: string) => `http://127.0.0.1:${port}${p}`;
const foreignUrl = (p: string) => `http://localhost:${port}${p}`;
const REFUSED = /Domain not allowed by your token scope: localhost/;

describe('token domain limit on every navigation', () => {
  test('goto to an allowed domain works', () => {
    expect(steps['goto-allowed'].status).toBe(200);
    expect(steps['goto-allowed'].url).toBe(allowedUrl('/start'));
  });

  test('a 302 from an allowed domain to a foreign domain is refused and blanks the tab', () => {
    expect(steps['redirect-foreign'].status).not.toBe(200);
    expect(steps['redirect-foreign'].result).toMatch(REFUSED);
    expect(steps['redirect-foreign'].url).toBe('about:blank');
  });

  test('a redirect that stays on the allowed domain works', () => {
    expect(steps['redirect-same'].status).toBe(200);
    expect(steps['redirect-same'].url).toBe(allowedUrl('/landed'));
  });

  test('a link click to a foreign domain is refused', () => {
    expect(steps['link-page'].status).toBe(200);
    expect(steps['link-foreign'].result).toMatch(REFUSED);
    expect(steps['link-foreign'].url).toBe('about:blank');
  });

  test('a script navigation to a foreign domain is refused', () => {
    expect(steps['script-page'].status).toBe(200);
    expect(steps['script-foreign'].result).toMatch(REFUSED);
    expect(steps['script-foreign'].url).toBe('about:blank');
  });

  test('a token with no domains limit still follows the redirect', () => {
    expect(steps['unlimited-redirect'].status).toBe(200);
    expect(steps['unlimited-redirect'].url).toBe(foreignUrl('/landed'));
  });

  test('the local CLI (root) still follows the redirect, also after a limited token used the tab', () => {
    expect(steps['root-redirect'].status).toBe(200);
    expect(steps['root-redirect'].url).toBe(foreignUrl('/landed'));
    expect(steps['root-after-limited'].status).toBe(200);
    expect(steps['root-after-limited-foreign'].status).toBe(200);
    expect(steps['root-after-limited-foreign'].url).toBe(foreignUrl('/landed'));
  });

  test('an own-only token is held to its domains on its own tab', () => {
    expect(steps['own-only-newtab'].status).toBe(200);
    expect(steps['own-only-redirect'].result).toMatch(REFUSED);
    expect(steps['own-only-redirect'].url).toBe('about:blank');
  });
});
