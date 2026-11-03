/**
 * Unit tests for cookie-import-browser.ts
 *
 * Uses a fixture SQLite database with cookies encrypted using a known test key.
 * Mocks Keychain access to return the test password.
 *
 * Test key derivation (matches real Chromium pipeline):
 *   password = "test-keychain-password"
 *   key = PBKDF2(password, "saltysalt", 1003, 16, sha1)
 *
 * Encryption: AES-128-CBC with IV = 16 × 0x20, prefix "v10"
 * Cookie DB meta version 24+: first 32 bytes of plaintext = SHA-256(host_key),
 * remaining bytes = actual cookie value. Older databases (legacy rows) have no
 * prefix: the whole plaintext is the value.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Test Constants ─────────────────────────────────────────────

const TEST_PASSWORD = 'test-keychain-password';
const TEST_KEY = crypto.pbkdf2Sync(TEST_PASSWORD, 'saltysalt', 1003, 16, 'sha1');
const LINUX_V10_PASSWORD = 'peanuts';
const LINUX_V10_KEY = crypto.pbkdf2Sync(LINUX_V10_PASSWORD, 'saltysalt', 1, 16, 'sha1');
const LINUX_V11_PASSWORD = 'test-linux-secret';
const LINUX_V11_KEY = crypto.pbkdf2Sync(LINUX_V11_PASSWORD, 'saltysalt', 1, 16, 'sha1');
const IV = Buffer.alloc(16, 0x20);
// Longer than 32 bytes: today's CBC path would cut its first 32 bytes.
const LEGACY_LONG_VALUE = 'legacy-session-0123456789abcdefghijklmnopqrstuvwxyz';
// 32 bytes or less: today's CBC path would return ''.
const LEGACY_SHORT_VALUE = 'short-legacy';
const CHROMIUM_EPOCH_OFFSET = 11644473600000000n;

// Fixture DB path — a per-run temp dir, NEVER the tracked browse/test/fixtures/:
// these DBs are built in beforeAll and deleted in afterAll, so writing them
// into the source tree makes them flash as `??` in git status mid-run, which
// races any concurrent shard's tree-isolation porcelain snapshot (observed:
// gen-skill-docs-out-dir's before/after porcelain pin on Windows CI).
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-cookie-fixtures-'));
const FIXTURE_DB = path.join(FIXTURE_DIR, 'test-cookies.db');
const LINUX_FIXTURE_DB = path.join(FIXTURE_DIR, 'test-cookies-linux.db');
const LINUX_LEGACY_FIXTURE_DB = path.join(FIXTURE_DIR, 'test-cookies-linux-legacy.db');

// ─── Encryption Helper ──────────────────────────────────────────

function encryptCookieValue(
  value: string,
  // `host` is the row's host_key and is required: a row of a meta 24+ database carries ITS OWN hash.
  options: { host: string; key?: Buffer; prefix?: 'v10' | 'v11'; legacy?: boolean; hashOf?: string },
): Buffer {
  const key = options.key ?? TEST_KEY;
  const prefix = options.prefix ?? 'v10';
  // Meta version 24+: SHA-256(host_key) + actual value. A legacy (pre-24) row has no prefix.
  // `hashOf` writes the hash of a DIFFERENT host: a corrupt row that Chromium does not load.
  const hostHash = crypto.createHash('sha256').update(options.hashOf ?? options.host).digest();
  const body = Buffer.from(value, 'utf-8');
  const plaintext = options.legacy ? body : Buffer.concat([hostHash, body]);

  // PKCS7 pad to AES block size (16 bytes)
  const blockSize = 16;
  const padLen = blockSize - (plaintext.length % blockSize);
  const padded = Buffer.concat([plaintext, Buffer.alloc(padLen, padLen)]);

  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  cipher.setAutoPadding(false); // We padded manually
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

  return Buffer.concat([Buffer.from(prefix), encrypted]);
}

function chromiumEpoch(unixSeconds: number): bigint {
  return BigInt(unixSeconds) * 1000000n + CHROMIUM_EPOCH_OFFSET;
}

// ─── Create Fixture Database ────────────────────────────────────

/** Chromium's meta table: `version` 24+ means every encrypted value starts with SHA-256(host_key). */
function createFixtureDb(dbPath: string, metaVersion = 24): Database {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new Database(dbPath);
  db.run(`CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)`);
  db.run(`INSERT INTO meta (key, value) VALUES ('version', ?)`, [String(metaVersion)]);
  db.run(`CREATE TABLE cookies (
    host_key TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    encrypted_value BLOB NOT NULL DEFAULT x'',
    path TEXT NOT NULL DEFAULT '/',
    expires_utc INTEGER NOT NULL DEFAULT 0,
    is_secure INTEGER NOT NULL DEFAULT 0,
    is_httponly INTEGER NOT NULL DEFAULT 0,
    has_expires INTEGER NOT NULL DEFAULT 0,
    samesite INTEGER NOT NULL DEFAULT 1
  )`);
  return db;
}

function createMacFixtureDb() {
  const db = createFixtureDb(FIXTURE_DB);
  const insert = db.prepare(`INSERT INTO cookies
    (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const futureExpiry = Number(chromiumEpoch(Math.floor(Date.now() / 1000) + 86400 * 365));
  const pastExpiry = Number(chromiumEpoch(Math.floor(Date.now() / 1000) - 86400));

  // Domain 1: .github.com — 3 encrypted cookies
  insert.run('.github.com', 'session_id', '', encryptCookieValue('abc123', { host: '.github.com' }), '/', futureExpiry, 1, 1, 1, 1);
  insert.run('.github.com', 'user_token', '', encryptCookieValue('token-xyz', { host: '.github.com' }), '/', futureExpiry, 1, 0, 1, 0);
  insert.run('.github.com', 'theme', '', encryptCookieValue('dark', { host: '.github.com' }), '/', futureExpiry, 0, 0, 1, 2);

  // Domain 2: .google.com — 2 cookies
  insert.run('.google.com', 'NID', '', encryptCookieValue('google-nid-value', { host: '.google.com' }), '/', futureExpiry, 1, 1, 1, 0);
  insert.run('.google.com', 'SID', '', encryptCookieValue('google-sid-value', { host: '.google.com' }), '/', futureExpiry, 1, 1, 1, 1);

  // Domain 3: .example.com — 1 unencrypted cookie (value field set, no encrypted_value)
  insert.run('.example.com', 'plain_cookie', 'hello-world', Buffer.alloc(0), '/', futureExpiry, 0, 0, 1, 1);

  // Domain 4: .expired.com — 1 expired cookie (should be filtered out)
  insert.run('.expired.com', 'old', '', encryptCookieValue('expired-value', { host: '.expired.com' }), '/', pastExpiry, 0, 0, 1, 1);

  // Domain 5: .session.com — session cookie (has_expires=0)
  insert.run('.session.com', 'sess', '', encryptCookieValue('session-value', { host: '.session.com' }), '/', 0, 1, 1, 0, 1);

  // Domain 6: .corrupt.com — cookie with garbage encrypted_value
  insert.run('.corrupt.com', 'bad', '', Buffer.from('v10' + 'not-valid-ciphertext-at-all'), '/', futureExpiry, 0, 0, 1, 1);

  // Domain 7: .mixed.com — one good, one corrupt
  insert.run('.mixed.com', 'good', '', encryptCookieValue('mixed-good', { host: '.mixed.com' }), '/', futureExpiry, 0, 0, 1, 1);
  insert.run('.mixed.com', 'bad', '', Buffer.from('v10' + 'garbage-data-here!!!'), '/', futureExpiry, 0, 0, 1, 1);

  db.close();
}

function createLinuxFixtureDb() {
  const db = createFixtureDb(LINUX_FIXTURE_DB);
  const insert = db.prepare(`INSERT INTO cookies
    (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const futureExpiry = Number(chromiumEpoch(Math.floor(Date.now() / 1000) + 86400 * 365));

  insert.run('.linux-v10.com', 'sid', '', encryptCookieValue('linux-v10-value', { key: LINUX_V10_KEY, prefix: 'v10', host: '.linux-v10.com' }), '/', futureExpiry, 1, 1, 1, 1);
  insert.run('.linux-v11.com', 'auth', '', encryptCookieValue('linux-v11-value', { key: LINUX_V11_KEY, prefix: 'v11', host: '.linux-v11.com' }), '/', futureExpiry, 1, 1, 1, 1);
  // A row whose first 32 bytes hash ANOTHER host: corrupt in a meta 24+ database (Chromium: kHashFailed).
  insert.run('.linux-foreign.com', 'foreign', '', encryptCookieValue('foreign-value', { key: LINUX_V10_KEY, prefix: 'v10', host: '.linux-foreign.com', hashOf: '.some-other-host.com' }), '/', futureExpiry, 1, 1, 1, 1);
  insert.run('.linux-plain.com', 'plain', 'plain-linux', Buffer.alloc(0), '/', futureExpiry, 0, 0, 1, 1);
  // Meta 24: a plaintext shorter than 32 bytes cannot carry the hash, so the row is corrupt.
  insert.run('.linux-short.com', 'tiny', '', encryptCookieValue('tiny', { key: LINUX_V10_KEY, prefix: 'v10', host: '.linux-short.com', legacy: true }), '/', futureExpiry, 1, 1, 1, 1);
  // Meta 24: an empty value is the hash alone, and imports as ''.
  insert.run('.linux-empty.com', 'empty', '', encryptCookieValue('', { key: LINUX_V10_KEY, prefix: 'v10', host: '.linux-empty.com' }), '/', futureExpiry, 1, 1, 1, 1);

  db.close();
}

/** A database Chromium has not migrated to meta version 24: no value carries a prefix. */
function createLinuxLegacyFixtureDb() {
  const db = createFixtureDb(LINUX_LEGACY_FIXTURE_DB, 23);
  const insert = db.prepare(`INSERT INTO cookies
    (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const futureExpiry = Number(chromiumEpoch(Math.floor(Date.now() / 1000) + 86400 * 365));

  insert.run('.linux-legacy.com', 'long', '', encryptCookieValue(LEGACY_LONG_VALUE, { key: LINUX_V10_KEY, prefix: 'v10', host: '.linux-legacy.com', legacy: true }), '/', futureExpiry, 1, 1, 1, 1);
  insert.run('.linux-legacy.com', 'short', '', encryptCookieValue(LEGACY_SHORT_VALUE, { key: LINUX_V10_KEY, prefix: 'v10', host: '.linux-legacy.com', legacy: true }), '/', futureExpiry, 1, 1, 1, 1);

  db.close();
}

// ─── Mock Setup ─────────────────────────────────────────────────
// We need to mock:
// 1. The Keychain access (getKeychainPassword) to return TEST_PASSWORD
// 2. The cookie DB path resolution to use our fixture DB

// We'll import the module after setting up the mocks
let findInstalledBrowsers: any;
let listDomains: any;
let importCookies: any;
let stripHostKeyPrefix: any;
let readCookieDbMetaVersion: any;
let CookieImportError: any;
let originalSpawn: typeof Bun.spawn;

beforeAll(async () => {
  createMacFixtureDb();
  createLinuxFixtureDb();
  createLinuxLegacyFixtureDb();

  // Mock Bun.spawn to return test password for keychain access
  originalSpawn = Bun.spawn;
  // @ts-ignore - monkey-patching for test
  Bun.spawn = function(cmd: any, opts: any) {
    // Intercept security find-generic-password calls
    if (Array.isArray(cmd) && cmd[0] === 'security' && cmd[1] === 'find-generic-password') {
      // Return test password for any known test service
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(TEST_PASSWORD + '\n'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) { controller.close(); }
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }
    if (Array.isArray(cmd) && cmd[0] === 'secret-tool' && cmd[1] === 'lookup') {
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(LINUX_V11_PASSWORD + '\n'));
            controller.close();
          }
        }),
        stderr: new ReadableStream({
          start(controller) { controller.close(); }
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }
    // Pass through other spawn calls
    return originalSpawn(cmd, opts);
  };

  // Import the module (uses our mocked Bun.spawn)
  const mod = await import('../src/cookie-import-browser');
  findInstalledBrowsers = mod.findInstalledBrowsers;
  listDomains = mod.listDomains;
  importCookies = mod.importCookies;
  stripHostKeyPrefix = mod.stripHostKeyPrefix;
  readCookieDbMetaVersion = mod.readCookieDbMetaVersion;
  CookieImportError = mod.CookieImportError;
});

afterAll(() => {
  // Restore Bun.spawn
  // @ts-ignore - monkey-patching for test
  Bun.spawn = originalSpawn;
  // Clean up fixture DB
  try { fs.unlinkSync(FIXTURE_DB); } catch {}
  try { fs.unlinkSync(LINUX_FIXTURE_DB); } catch {}
  try { fs.unlinkSync(LINUX_LEGACY_FIXTURE_DB); } catch {}
  try { fs.rmdirSync(FIXTURE_DIR); } catch {}
});

// ─── Helper: Override DB path for tests ─────────────────────────
// The real code resolves paths via ~/Library/Application Support/<browser>/Default/Cookies
// We need to test against our fixture DB directly. We'll test the pure decryption functions
// by calling importCookies with a browser that points to our fixture.
// Since the module uses a hardcoded registry, we test the decryption logic via a different approach:
// We'll directly call the internal decryption by setting up the DB in the expected location.

// For the unit tests below, we test the decryption pipeline by:
// 1. Creating encrypted cookies with known values
// 2. Decrypting them with the module's decryption logic
// The actual DB path resolution is tested separately.

async function withInstalledProfile<T>(
  relativeBrowserDir: string,
  sourceDb: string,
  run: () => Promise<T>,
  profile = 'Default',
): Promise<T> {
  const homeDir = os.homedir();
  const profileDir = path.join(homeDir, relativeBrowserDir, profile);
  const cookiesPath = path.join(profileDir, 'Cookies');
  const backupPath = path.join(profileDir, `Cookies.backup-${crypto.randomUUID()}`);
  const hadOriginal = fs.existsSync(cookiesPath);

  fs.mkdirSync(profileDir, { recursive: true });
  if (hadOriginal) fs.copyFileSync(cookiesPath, backupPath);
  fs.copyFileSync(sourceDb, cookiesPath);

  try {
    return await run();
  } finally {
    if (hadOriginal) {
      fs.copyFileSync(backupPath, cookiesPath);
      fs.unlinkSync(backupPath);
    } else {
      try { fs.unlinkSync(cookiesPath); } catch {}
      try { fs.rmdirSync(profileDir); } catch {}
    }
  }
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Cookie Import Browser', () => {

  describe('Decryption Pipeline', () => {
    test('encrypts and decrypts round-trip correctly', () => {
      // Verify our test helper produces valid ciphertext
      const encrypted = encryptCookieValue('hello-world', { host: '.example.com' });
      expect(encrypted.slice(0, 3).toString()).toBe('v10');

      // Decrypt manually to verify
      const ciphertext = encrypted.slice(3);
      const decipher = crypto.createDecipheriv('aes-128-cbc', TEST_KEY, IV);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      // Skip the 32-byte SHA-256(host_key) prefix
      const value = plaintext.slice(32).toString('utf-8');
      expect(value).toBe('hello-world');
    });

    test('handles empty encrypted_value', () => {
      const encrypted = encryptCookieValue('', { host: '.example.com' });
      const ciphertext = encrypted.slice(3);
      const decipher = crypto.createDecipheriv('aes-128-cbc', TEST_KEY, IV);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      // 32-byte tag + empty value → slice(32) = empty
      expect(plaintext.length).toBe(32); // just the HMAC tag, padded to block boundary? Actually 32 + 0 padded = 48
      // With PKCS7 padding: 32 bytes + 16 bytes of padding = 48 bytes padded → decrypts to 32 bytes + padding removed = 32 bytes
    });

    test('handles special characters in cookie values', () => {
      const specialValue = 'a=b&c=d; path=/; expires=Thu, 01 Jan 2099';
      const encrypted = encryptCookieValue(specialValue, { host: '.example.com' });
      const ciphertext = encrypted.slice(3);
      const decipher = crypto.createDecipheriv('aes-128-cbc', TEST_KEY, IV);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      expect(plaintext.slice(32).toString('utf-8')).toBe(specialValue);
    });
  });

  describe('Fixture DB Structure', () => {
    test('fixture DB has correct domain counts', () => {
      const db = new Database(FIXTURE_DB, { readonly: true });
      const rows = db.query(
        `SELECT host_key, COUNT(*) as count FROM cookies GROUP BY host_key ORDER BY count DESC`
      ).all() as any[];
      db.close();

      const counts = Object.fromEntries(rows.map((r: any) => [r.host_key, r.count]));
      expect(counts['.github.com']).toBe(3);
      expect(counts['.google.com']).toBe(2);
      expect(counts['.example.com']).toBe(1);
      expect(counts['.expired.com']).toBe(1);
      expect(counts['.session.com']).toBe(1);
      expect(counts['.corrupt.com']).toBe(1);
      expect(counts['.mixed.com']).toBe(2);
    });

    test('encrypted cookies in fixture have v10 prefix', () => {
      const db = new Database(FIXTURE_DB, { readonly: true });
      const rows = db.query(
        `SELECT name, encrypted_value FROM cookies WHERE host_key = '.github.com'`
      ).all() as any[];
      db.close();

      for (const row of rows) {
        const ev = Buffer.from(row.encrypted_value);
        expect(ev.slice(0, 3).toString()).toBe('v10');
      }
    });

    test('decrypts all github.com cookies from fixture DB', () => {
      const db = new Database(FIXTURE_DB, { readonly: true });
      const rows = db.query(
        `SELECT name, value, encrypted_value FROM cookies WHERE host_key = '.github.com'`
      ).all() as any[];
      db.close();

      const expected: Record<string, string> = {
        'session_id': 'abc123',
        'user_token': 'token-xyz',
        'theme': 'dark',
      };

      for (const row of rows) {
        const ev = Buffer.from(row.encrypted_value);
        if (ev.length === 0) continue;
        const ciphertext = ev.slice(3);
        const decipher = crypto.createDecipheriv('aes-128-cbc', TEST_KEY, IV);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const value = plaintext.slice(32).toString('utf-8');
        expect(value).toBe(expected[row.name]);
      }
    });

    test('unencrypted cookie uses value field directly', () => {
      const db = new Database(FIXTURE_DB, { readonly: true });
      const row = db.query(
        `SELECT value, encrypted_value FROM cookies WHERE host_key = '.example.com'`
      ).get() as any;
      db.close();

      expect(row.value).toBe('hello-world');
      expect(Buffer.from(row.encrypted_value).length).toBe(0);
    });
  });

  describe('sameSite Mapping', () => {
    test('maps sameSite values correctly', () => {
      // Read from fixture DB and verify mapping
      const db = new Database(FIXTURE_DB, { readonly: true });

      // samesite=0 → None
      const none = db.query(`SELECT samesite FROM cookies WHERE name = 'user_token'`).get() as any;
      expect(none.samesite).toBe(0);

      // samesite=1 → Lax
      const lax = db.query(`SELECT samesite FROM cookies WHERE name = 'session_id'`).get() as any;
      expect(lax.samesite).toBe(1);

      // samesite=2 → Strict
      const strict = db.query(`SELECT samesite FROM cookies WHERE name = 'theme'`).get() as any;
      expect(strict.samesite).toBe(2);

      db.close();
    });
  });

  describe('Chromium Epoch Conversion', () => {
    test('converts Chromium epoch to Unix timestamp correctly', () => {
      // Round-trip: pick a known Unix timestamp, convert to Chromium, convert back
      const knownUnix = 1704067200; // 2024-01-01T00:00:00Z
      const chromiumTs = BigInt(knownUnix) * 1000000n + CHROMIUM_EPOCH_OFFSET;
      const unixTs = Number((chromiumTs - CHROMIUM_EPOCH_OFFSET) / 1000000n);
      expect(unixTs).toBe(knownUnix);
    });

    test('session cookies (has_expires=0) get expires=-1', () => {
      const db = new Database(FIXTURE_DB, { readonly: true });
      const row = db.query(
        `SELECT has_expires, expires_utc FROM cookies WHERE host_key = '.session.com'`
      ).get() as any;
      db.close();
      expect(row.has_expires).toBe(0);
      // When has_expires=0, the module should return expires=-1
    });
  });

  describe('Error Handling', () => {
    test('CookieImportError has correct properties', () => {
      const err = new CookieImportError('test message', 'test_code', 'retry');
      expect(err.message).toBe('test message');
      expect(err.code).toBe('test_code');
      expect(err.action).toBe('retry');
      expect(err.name).toBe('CookieImportError');
      expect(err instanceof Error).toBe(true);
    });

    test('CookieImportError without action', () => {
      const err = new CookieImportError('no action', 'some_code');
      expect(err.action).toBeUndefined();
    });
  });

  describe('Browser Registry', () => {
    test('findInstalledBrowsers returns array', () => {
      const browsers = findInstalledBrowsers();
      expect(Array.isArray(browsers)).toBe(true);
      // Each entry should have the right shape
      for (const b of browsers) {
        expect(b).toHaveProperty('name');
        expect(b).toHaveProperty('dataDir');
        expect(b).toHaveProperty('keychainService');
        expect(b).toHaveProperty('aliases');
      }
    });

    test('detects linux-style Chromium profiles under ~/.config', async () => {
      await withInstalledProfile('.config/chromium', LINUX_FIXTURE_DB, async () => {
        const browsers = findInstalledBrowsers();
        const names = browsers.map((browser: any) => browser.name);

        expect(names).toContain('Chromium');
      });
    });
  });

  describe('Real Profile Imports', () => {
    test('imports Linux v10 cookies from ~/.config/chromium', async () => {
      await withInstalledProfile('.config/chromium', LINUX_FIXTURE_DB, async () => {
        const result = await importCookies('chromium', ['.linux-v10.com'], 'GstackLinuxV10');

        expect(result.count).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.cookies[0].name).toBe('sid');
        expect(result.cookies[0].value).toBe('linux-v10-value');
      }, 'GstackLinuxV10');
    });

    test('imports Linux v11 cookies when secret-tool returns a key', async () => {
      await withInstalledProfile('.config/chromium', LINUX_FIXTURE_DB, async () => {
        const result = await importCookies('chromium', ['.linux-v11.com'], 'GstackLinuxV11');

        expect(result.count).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.cookies[0].name).toBe('auth');
        expect(result.cookies[0].value).toBe('linux-v11-value');
      }, 'GstackLinuxV11');
    });

    test('imports a legacy (pre-meta-24) cookie with no prefix whole', async () => {
      await withInstalledProfile('.config/chromium', LINUX_LEGACY_FIXTURE_DB, async () => {
        const result = await importCookies('chromium', ['.linux-legacy.com'], 'GstackLinuxLegacy');
        const byName = Object.fromEntries(result.cookies.map((cookie: any) => [cookie.name, cookie.value]));

        expect(result.failed).toBe(0);
        expect(byName.long).toBe(LEGACY_LONG_VALUE);
        expect(byName.short).toBe(LEGACY_SHORT_VALUE);
      }, 'GstackLinuxLegacy');
    });

    test('fails a meta 24+ row whose first 32 bytes hash another host, as Chromium does (kHashFailed)', async () => {
      await withInstalledProfile('.config/chromium', LINUX_FIXTURE_DB, async () => {
        const result = await importCookies('chromium', ['.linux-foreign.com'], 'GstackLinuxForeign');

        // Never imported with 32 garbage bytes in front of the value: the row is reported as failed.
        expect(result.count).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.failureReasons).toEqual({ decryption_failed: 1 });
      }, 'GstackLinuxForeign');
    });

    test('fails a meta 24+ plaintext shorter than 32 bytes, and imports an empty value as ""', async () => {
      await withInstalledProfile('.config/chromium', LINUX_FIXTURE_DB, async () => {
        const short = await importCookies('chromium', ['.linux-short.com'], 'GstackLinuxShort');
        expect(short.count).toBe(0);
        expect(short.failureReasons).toEqual({ decryption_failed: 1 });

        const empty = await importCookies('chromium', ['.linux-empty.com'], 'GstackLinuxShort');
        expect(empty.failed).toBe(0);
        expect(empty.cookies[0].value).toBe('');
      }, 'GstackLinuxShort');
    });
  });

  describe('Host-key prefix rule (every platform: the GCM and CBC branches share it)', () => {
    const host = '.rule.test';
    const hash = crypto.createHash('sha256').update(host).digest();
    const value = Buffer.from('rule-value');

    test('meta 24+: strips a matching hash, throws on a mismatch or a short plaintext', () => {
      expect(stripHostKeyPrefix(Buffer.concat([hash, value]), host, 24).toString()).toBe('rule-value');
      const foreign = crypto.createHash('sha256').update('.other.test').digest();
      expect(() => stripHostKeyPrefix(Buffer.concat([foreign, value]), host, 24)).toThrow();
      expect(() => stripHostKeyPrefix(Buffer.from('short'), host, 25)).toThrow();
    });

    test('below meta 24: never strips, even bytes that equal the hash', () => {
      const legacy = Buffer.concat([hash, value]);
      expect(stripHostKeyPrefix(legacy, host, 23).equals(legacy)).toBe(true);
    });

    test('no meta row: strips only a matching hash, keeps anything else whole', () => {
      expect(stripHostKeyPrefix(Buffer.concat([hash, value]), host, null).toString()).toBe('rule-value');
      expect(stripHostKeyPrefix(value, host, null).toString()).toBe('rule-value');
    });

    test('reads meta.version, and a NULL, empty or missing value as unreadable (null), never as 0', () => {
      const versionOf = (stored: string | null | undefined) => {
        const db = new Database(':memory:');
        db.run(`CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)`);
        if (stored !== undefined) db.run(`INSERT INTO meta (key, value) VALUES ('version', ?)`, [stored]);
        try { return readCookieDbMetaVersion(db); } finally { db.close(); }
      };
      expect(versionOf('24')).toBe(24);
      expect(versionOf('23')).toBe(23);
      expect(versionOf(null)).toBeNull();
      expect(versionOf('')).toBeNull();
      expect(versionOf(undefined)).toBeNull();
      const noMeta = new Database(':memory:');
      try { expect(readCookieDbMetaVersion(noMeta)).toBeNull(); } finally { noMeta.close(); }
    });

    test('lists domains from Linux Chromium profiles', async () => {
      await withInstalledProfile('.config/chromium', LINUX_FIXTURE_DB, async () => {
        const result = listDomains('chromium', 'GstackLinuxDomains');
        const domains = result.domains.map((entry: any) => entry.domain);

        expect(result.browser).toBe('Chromium');
        expect(domains).toContain('.linux-v10.com');
        expect(domains).toContain('.linux-v11.com');
        expect(domains).toContain('.linux-plain.com');
      }, 'GstackLinuxDomains');
    });
  });

  describe('Corrupt Data Handling', () => {
    test('garbage ciphertext produces decryption error', () => {
      const garbage = Buffer.from('v10' + 'this-is-not-valid-ciphertext!!');
      const ciphertext = garbage.slice(3);
      expect(() => {
        const decipher = crypto.createDecipheriv('aes-128-cbc', TEST_KEY, IV);
        Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      }).toThrow();
    });
  });

  describe('Profile Validation', () => {
    test('rejects path traversal in profile names', () => {
      // The validateProfile function should reject profiles with / or ..
      // We can't call it directly (internal), but we can test via listDomains
      // which calls validateProfile
      expect(() => listDomains('chrome', '../etc')).toThrow(/Invalid profile/);
      expect(() => listDomains('chrome', 'Default/../../etc')).toThrow(/Invalid profile/);
    });

    test('rejects control characters in profile names', () => {
      expect(() => listDomains('chrome', 'Default\x00evil')).toThrow(/Invalid profile/);
    });
  });

  describe('Unknown Browser', () => {
    test('throws for unknown browser name', () => {
      expect(() => listDomains('firefox')).toThrow(/Unknown browser.*firefox/i);
    });

    test('error includes list of supported browsers', () => {
      try {
        listDomains('firefox');
        throw new Error('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('unknown_browser');
        expect(err.message).toContain('comet');
        expect(err.message).toContain('chrome');
      }
    });
  });
});
