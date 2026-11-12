/**
 * acquireServerLock mutual exclusion under concurrent starts.
 *
 * The create is exclusive (open 'wx'), but the stale-lock rule was not:
 *   - an EMPTY lock (owner between open('wx') and writing its pid) parsed as
 *     NaN and was removed at once, so a second starter took the lock while
 *     the first still held it;
 *   - two starters that both read the same dead pid both unlinked the path,
 *     so the slower one removed the faster one's NEW, live lock.
 * Either way 2 CLIs both "own" the lock and both spawn a daemon; one daemon
 * is orphaned with its browser and port.
 *
 * Contract pinned here:
 *   - N concurrent starts against a stale lock spawn exactly 1 daemon;
 *   - a live owner's lock is never removed (pid alive, or pid not yet
 *     written and the lock is younger than the write grace);
 *   - a lock left by a crash (dead pid, or empty and older than the grace)
 *     is recovered, so the next start is never stuck;
 *   - stale-lock removal is serialized by a short-lived break lock, and a
 *     break lock left by a crashed breaker is recovered by age.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireServerLock } from '../src/cli';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-lock-race-'));
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const DEAD_PID = '999999999';
const CLI_PATH = path.join(import.meta.dir, '..', 'src', 'cli.ts');

/** Set a file's mtime to `ageMs` in the past. */
function backdate(file: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

/**
 * A fake starter: the same shape as ensureServer() — take the lock, re-read
 * state under it, "spawn" (log a line, hold the lock for a startup delay,
 * write state) only when no daemon is up, then release. A starter that
 * loses the lock waits instead, so it never spawns.
 */
const STARTER_SRC = `
import * as fs from 'fs';
import { acquireServerLock } from ${JSON.stringify(CLI_PATH)};
const [lockPath, stateFile, spawnLog, goAt] = process.argv.slice(2);
while (Date.now() < Number(goAt)) {}
const release = acquireServerLock(lockPath);
if (release) {
  try {
    if (!fs.existsSync(stateFile)) {
      fs.appendFileSync(spawnLog, process.pid + '\\n');
      await Bun.sleep(300);
      fs.writeFileSync(stateFile, 'up');
    }
  } finally {
    release();
  }
}
`;

async function runConcurrentStarts(dir: string, n: number): Promise<number> {
  const lockPath = path.join(dir, 'browse.json.lock');
  const stateFile = path.join(dir, 'browse.json');
  const spawnLog = path.join(dir, 'spawns.log');
  const starter = path.join(dir, 'starter.ts');
  fs.writeFileSync(starter, STARTER_SRC);
  // A crashed previous owner: the next starts all see a stale lock at once.
  fs.writeFileSync(lockPath, `${DEAD_PID}\n`);
  const goAt = Date.now() + 2500; // all children leave the barrier together
  const procs = Array.from({ length: n }, () =>
    Bun.spawn([process.execPath, starter, lockPath, stateFile, spawnLog, String(goAt)], {
      stdout: 'ignore',
      stderr: 'pipe',
    }),
  );
  const codes = await Promise.all(procs.map((p) => p.exited));
  for (let i = 0; i < procs.length; i++) {
    if (codes[i] !== 0) {
      throw new Error(`starter ${i} exited ${codes[i]}: ${await new Response(procs[i].stderr).text()}`);
    }
  }
  return fs.existsSync(spawnLog)
    ? fs.readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
}

describe('acquireServerLock: concurrent starts', () => {
  test('N concurrent starts against a stale lock spawn exactly 1 daemon', async () => {
    // Several rounds: one round can miss the window by luck.
    const spawnCounts: number[] = [];
    for (let round = 0; round < 5; round++) {
      const dir = fs.mkdtempSync(path.join(tmpRoot, `round-${round}-`));
      spawnCounts.push(await runConcurrentStarts(dir, 12));
    }
    expect(spawnCounts).toEqual([1, 1, 1, 1, 1]);
  }, 90_000);
});

describe('acquireServerLock: stale-lock rule', () => {
  test('an empty lock younger than the write grace is a live owner: not removed', () => {
    // The owner has created the file with open('wx') but not yet written its pid.
    const lockPath = path.join(tmpRoot, 'empty-fresh.lock');
    fs.writeFileSync(lockPath, '');
    expect(acquireServerLock(lockPath)).toBeNull();
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('');
    fs.unlinkSync(lockPath);
  });

  test('an empty lock older than the write grace (crash between open and write) is recovered', () => {
    const lockPath = path.join(tmpRoot, 'empty-old.lock');
    fs.writeFileSync(lockPath, '');
    backdate(lockPath, 60_000);
    const release = acquireServerLock(lockPath);
    expect(release).not.toBeNull();
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    release!();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('a dead-pid lock (crash between lock and spawn) is recovered at once', () => {
    const lockPath = path.join(tmpRoot, 'dead.lock');
    fs.writeFileSync(lockPath, `${DEAD_PID}\n`);
    const release = acquireServerLock(lockPath);
    expect(release).not.toBeNull();
    release!();
    expect(fs.existsSync(`${lockPath}.break`)).toBe(false);
  });

  test('a fresh break lock means another starter is removing the stale lock: wait, remove nothing', () => {
    const lockPath = path.join(tmpRoot, 'breaking.lock');
    fs.writeFileSync(lockPath, `${DEAD_PID}\n`);
    fs.writeFileSync(`${lockPath}.break`, `${process.pid}\n`);
    expect(acquireServerLock(lockPath)).toBeNull();
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(DEAD_PID);
    expect(fs.existsSync(`${lockPath}.break`)).toBe(true);
    fs.unlinkSync(lockPath);
    fs.unlinkSync(`${lockPath}.break`);
  });

  test('a break lock left by a crashed breaker is recovered by age', () => {
    const lockPath = path.join(tmpRoot, 'broken-breaker.lock');
    fs.writeFileSync(lockPath, `${DEAD_PID}\n`);
    fs.writeFileSync(`${lockPath}.break`, `${DEAD_PID}\n`);
    backdate(`${lockPath}.break`, 60_000);
    const release = acquireServerLock(lockPath);
    expect(release).not.toBeNull();
    expect(fs.existsSync(`${lockPath}.break`)).toBe(false);
    release!();
  });
});
