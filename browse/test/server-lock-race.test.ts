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
 *     break lock left by a crashed breaker is recovered by age;
 *   - a stale break lock is recovered by rename-then-check, so two
 *     recoverers of one stale break file never both enter the break section;
 *   - a lock or break file is removed on release only while its inode is
 *     still the one its owner created (an owner whose lock was broken during
 *     a long stall gets no lock and never removes the new owner's lock).
 */

import { describe, test, expect, afterAll, spyOn } from 'bun:test';
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

/**
 * Fixed-order interleavings, in process. spyOn on the `fs` namespace reaches
 * cli.ts's own `import * as fs`. Each spy is restored in `finally`.
 */
describe('acquireServerLock: fixed-order interleavings', () => {
  function patchFs<K extends 'statSync' | 'readFileSync' | 'writeSync'>(
    name: K,
    wrap: (orig: (typeof fs)[K]) => (typeof fs)[K],
  ): () => void {
    const orig = fs[name];
    const spy = spyOn(fs, name).mockImplementation(wrap(orig) as any);
    return () => spy.mockRestore();
  }

  test('two starters that recover one stale break file: only one enters the break section', () => {
    // B stats the old break file. Before B acts, A recovers the same file and
    // creates its own NEW break file (A now holds the break lock). B must not
    // remove A's live break file and must not take the lock.
    const lockPath = path.join(tmpRoot, 'two-recoverers.lock');
    const breakPath = `${lockPath}.break`;
    fs.writeFileSync(lockPath, `${DEAD_PID}\n`);
    fs.writeFileSync(breakPath, `${DEAD_PID}\n`);
    backdate(breakPath, 60_000);
    let interleaved = false;
    const restore = patchFs('statSync', (orig) => ((p: fs.PathLike, ...rest: unknown[]) => {
      const result = (orig as any)(p, ...rest);
      if (p === breakPath && !interleaved) {
        interleaved = true;
        fs.unlinkSync(breakPath); // A: recovers the stale break file
        fs.writeFileSync(breakPath, 'A\n'); // A: holds a fresh break lock
      }
      return result; // B: still sees the OLD stat
    }) as any);
    let release: (() => void) | null;
    try {
      release = acquireServerLock(lockPath);
    } finally {
      restore();
    }
    expect(interleaved).toBe(true);
    expect(release).toBeNull();
    expect(fs.readFileSync(breakPath, 'utf8')).toBe('A\n');
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(DEAD_PID);
    expect(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('two-recoverers.lock.break.'))).toEqual([]);
    fs.unlinkSync(breakPath);
    fs.unlinkSync(lockPath);
  });

  test('a breaker whose break file was taken over does not remove the new break file on exit', () => {
    const lockPath = path.join(tmpRoot, 'taken-break.lock');
    const breakPath = `${lockPath}.break`;
    fs.writeFileSync(lockPath, `${DEAD_PID}\n`);
    let reads = 0;
    const restore = patchFs('readFileSync', (orig) => ((p: any, ...rest: unknown[]) => {
      // Read 1: the staleness check before the break lock. Read 2: the check
      // under it — another starter replaces the break file at that point.
      if (p === lockPath && ++reads === 2) {
        fs.unlinkSync(breakPath);
        fs.writeFileSync(breakPath, 'other\n');
      }
      return (orig as any)(p, ...rest);
    }) as any);
    let release: (() => void) | null;
    try {
      release = acquireServerLock(lockPath);
    } finally {
      restore();
    }
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(breakPath, 'utf8')).toBe('other\n');
    release?.();
    fs.unlinkSync(breakPath);
  });

  test('an owner whose lock was broken while it stalled before the pid write gets no lock', () => {
    // Between open('wx') and writeSync, another starter judges the empty lock
    // stale, removes it and creates its own. The stalled owner must see that.
    const lockPath = path.join(tmpRoot, 'stalled-owner.lock');
    let stalled = false;
    const restore = patchFs('writeSync', (orig) => ((fd: number, data: any, ...rest: unknown[]) => {
      if (!stalled && data === `${process.pid}\n` && fs.existsSync(lockPath)) {
        stalled = true;
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, `${DEAD_PID}\n`);
      }
      return (orig as any)(fd, data, ...rest);
    }) as any);
    let release: (() => void) | null;
    try {
      release = acquireServerLock(lockPath);
    } finally {
      restore();
    }
    expect(stalled).toBe(true);
    expect(release).toBeNull();
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(DEAD_PID);
    fs.unlinkSync(lockPath);
  });

  test('release does not remove a lock that another starter now owns', () => {
    const lockPath = path.join(tmpRoot, 'release-other.lock');
    const release = acquireServerLock(lockPath);
    expect(release).not.toBeNull();
    // Our lock was broken (e.g. after a long stall) and another starter owns the path.
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, 'other\n');
    release!();
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('other\n');
    fs.unlinkSync(lockPath);
  });
});
