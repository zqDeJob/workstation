const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { URL } = require('url');
const { readCookiesFromBrowserViaCdp, isProcessRunning } = require('./chrome-cdp-cookies');

const BROWSER_PARTITION = 'persist:browser';

let Database = null;
let sqlJsPromise = null;

function getBetterSqlite() {
  if (Database !== null) {
    return Database;
  }

  try {
    Database = require('better-sqlite3');
  } catch {
    Database = false;
  }

  return Database;
}

function getSqlJs() {
  if (!sqlJsPromise) {
    const initSqlJs = require('sql.js');
    sqlJsPromise = initSqlJs({
      locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
    });
  }

  return sqlJsPromise;
}

function getUserDataDir(browser) {
  const roots = {
    chrome: path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    edge: path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
  };

  return roots[browser];
}

function getBrowserProfiles(browser) {
  const userDataDir = getUserDataDir(browser);
  if (!userDataDir || !fs.existsSync(userDataDir)) return [];

  return fs
    .readdirSync(userDataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === 'Default' || /^Profile \d+$/.test(name));
}

function getProfileCookiesPath(browser, profile) {
  const base = path.join(getUserDataDir(browser), profile);
  const network = path.join(base, 'Network', 'Cookies');
  if (fs.existsSync(network)) return network;

  const legacy = path.join(base, 'Cookies');
  if (fs.existsSync(legacy)) return legacy;

  return null;
}

function listAvailableBrowsers() {
  return ['chrome', 'edge'].filter((browser) =>
    getBrowserProfiles(browser).some((profile) => Boolean(getProfileCookiesPath(browser, profile)))
  );
}

function resolveBrowserSources(source) {
  const available = listAvailableBrowsers();

  if (source === 'chrome' || source === 'edge') {
    return available.includes(source) ? [source] : [];
  }

  if (available.includes('chrome')) return ['chrome'];
  if (available.includes('edge')) return ['edge'];
  return [];
}

function dpapiUnprotect(buffer) {
  const b64 = buffer.toString('base64');
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${b64}')`,
    "$o=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
    '[Convert]::ToBase64String($o)',
  ].join('; ');

  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }
  ).trim();

  return Buffer.from(out, 'base64');
}

const encryptionKeyCache = new Map();

function getEncryptionKey(browser) {
  if (encryptionKeyCache.has(browser)) {
    return encryptionKeyCache.get(browser);
  }

  const localStatePath = path.join(getUserDataDir(browser), 'Local State');
  if (!fs.existsSync(localStatePath)) {
    encryptionKeyCache.set(browser, null);
    return null;
  }

  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encryptedKeyB64 = localState?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) {
    encryptionKeyCache.set(browser, null);
    return null;
  }

  const encryptedKey = Buffer.from(encryptedKeyB64, 'base64');
  const key = dpapiUnprotect(encryptedKey.slice(5));
  encryptionKeyCache.set(browser, key);
  return key;
}

function getAppBoundKey(browser) {
  if (encryptionKeyCache.has(`${browser}:appbound`)) {
    return encryptionKeyCache.get(`${browser}:appbound`);
  }

  encryptionKeyCache.set(`${browser}:appbound`, null);
  return null;
}

function decryptCookieValue(encryptedValue, browser) {
  if (!encryptedValue || encryptedValue.length === 0) {
    return '';
  }

  const buffer = Buffer.isBuffer(encryptedValue)
    ? encryptedValue
    : Buffer.from(encryptedValue);

  const prefix = buffer.slice(0, 3).toString('utf8');
  if (prefix === 'v20') {
    const key = getAppBoundKey(browser);
    if (!key) return '';

    const nonce = buffer.slice(3, 15);
    const tag = buffer.slice(buffer.length - 16);
    const data = buffer.slice(15, buffer.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.length > 32 ? plain.slice(32).toString('utf8') : plain.toString('utf8');
  }

  if (prefix === 'v10' || prefix === 'v11') {
    const key = getEncryptionKey(browser);
    if (!key) return '';

    const nonce = buffer.slice(3, 15);
    const tag = buffer.slice(buffer.length - 16);
    const data = buffer.slice(15, buffer.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  if (buffer[0] === 0x01) {
    return dpapiUnprotect(buffer).toString('utf8');
  }

  return buffer.toString('utf8');
}

function chromiumToUnix(expires) {
  if (!expires) return undefined;
  const unix = (Number(expires) - 11644473600000000) / 1000000;
  return unix > 0 ? unix : undefined;
}

function mapSameSite(value) {
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'no_restriction':
      case 'none':
        return 'no_restriction';
      case 'lax':
        return 'lax';
      case 'strict':
        return 'strict';
      default:
        return 'unspecified';
    }
  }

  switch (Number(value)) {
    case 1:
      return 'no_restriction';
    case 2:
      return 'lax';
    case 3:
      return 'strict';
    default:
      return 'unspecified';
  }
}

function sanitizeCookieValue(value) {
  if (!value) return '';
  return String(value).replace(/[\u0000-\u001F\u007F]/g, '');
}

function domainMatches(hostname, hostKey) {
  if (!hostKey) return false;
  if (hostKey.startsWith('.')) {
    const bare = hostKey.slice(1);
    return hostname === bare || hostname.endsWith(hostKey);
  }
  return hostname === hostKey;
}

function snapshotCookieDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ws-cookies-'));

  for (const suffix of ['', '-wal', '-shm']) {
    const src = path.join(dir, base + suffix);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(tempDir, base + suffix));
    }
  }

  return { dbPath: path.join(tempDir, base), tempDir };
}

function cleanupSnapshot(tempDir) {
  if (!tempDir) return;

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function queryWithBetterSqlite(dbPath) {
  const SqliteDatabase = getBetterSqlite();
  if (!SqliteDatabase) {
    return null;
  }

  let snapshot = null;

  try {
    const db = new SqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
    return { rows: queryRowsFromBetterSqlite(db), cleanup: () => db.close() };
  } catch (err) {
    if (
      !/locked|busy|ENOENT|unable to open database file|different Node\.js version|NODE_MODULE_VERSION/i.test(
        String(err.message)
      )
    ) {
      throw err;
    }
  }

  snapshot = snapshotCookieDatabase(dbPath);

  try {
    const db = new SqliteDatabase(snapshot.dbPath, { readonly: true, fileMustExist: true });
    return {
      rows: queryRowsFromBetterSqlite(db),
      cleanup: () => {
        db.close();
        cleanupSnapshot(snapshot.tempDir);
      },
    };
  } catch (err) {
    cleanupSnapshot(snapshot.tempDir);
    if (!/different Node\.js version|NODE_MODULE_VERSION/i.test(String(err.message))) {
      throw err;
    }
    return null;
  }
}

function queryRowsFromBetterSqlite(db) {
  const columns = 'host_key, path, is_secure, expires_utc, name, value, encrypted_value, is_httponly';
  const hasSameSite = db
    .prepare("SELECT 1 FROM pragma_table_info('cookies') WHERE name = 'same_site'")
    .get();

  const selectSql = hasSameSite
    ? `SELECT ${columns}, same_site FROM cookies`
    : `SELECT ${columns} FROM cookies`;

  return db.prepare(selectSql).all();
}

async function queryWithSqlJs(dbPath) {
  let snapshot = null;
  let actualPath = dbPath;

  try {
    const SqliteDatabase = getBetterSqlite();
    if (SqliteDatabase) {
      const db = new SqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
      db.close();
    } else {
      fs.accessSync(dbPath, fs.constants.R_OK);
    }
  } catch {
    snapshot = snapshotCookieDatabase(dbPath);
    actualPath = snapshot.dbPath;
  }

  const SQL = await getSqlJs();
  const db = new SQL.Database(fs.readFileSync(actualPath));
  const hasSameSite = db.exec("SELECT 1 FROM pragma_table_info('cookies') WHERE name = 'same_site'");
  const columns = 'host_key, path, is_secure, expires_utc, name, value, encrypted_value, is_httponly';
  const selectSql = hasSameSite.length
    ? `SELECT ${columns}, same_site FROM cookies`
    : `SELECT ${columns} FROM cookies`;
  const stmt = db.prepare(selectSql);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }

  stmt.free();
  db.close();

  return {
    rows,
    cleanup: () => cleanupSnapshot(snapshot?.tempDir),
  };
}

async function loadCookieRows(dbPath) {
  const better = queryWithBetterSqlite(dbPath);
  if (better) {
    return better;
  }

  return queryWithSqlJs(dbPath);
}

function rowToCookie(row, browser, hostname) {
  let value = row.value;
  if (!value && row.encrypted_value?.length) {
    const encrypted = Buffer.isBuffer(row.encrypted_value)
      ? row.encrypted_value
      : Buffer.from(row.encrypted_value);
    value = decryptCookieValue(encrypted, browser);
  }

  const cookie = {
    name: row.name,
    value,
    domain: row.host_key,
    hostOnly: !String(row.host_key || '').startsWith('.'),
    path: row.path || '/',
    Secure: Boolean(row.is_secure),
    HttpOnly: Boolean(row.is_httponly),
    expires: row.expires_utc,
    sameSite: mapSameSite(row.same_site),
  };

  if (!cookie.value || !domainMatches(hostname, cookie.domain)) {
    return null;
  }

  return cookie;
}

async function readCookiesFromProfile(url, browser, profile) {
  const dbPath = getProfileCookiesPath(browser, profile);
  if (!dbPath) {
    return [];
  }

  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const { rows, cleanup } = await loadCookieRows(dbPath);

  try {
    return rows
      .filter((row) => String(row.host_key || '').includes(hostname))
      .map((row) => rowToCookie(row, browser, hostname))
      .filter(Boolean);
  } finally {
    cleanup();
  }
}

function scoreCookies(cookies) {
  const names = new Set(cookies.map((cookie) => cookie.name));
  let score = cookies.length;

  for (const important of [
    'user_session',
    '__Host-user_session_same_site',
    'logged_in',
    'dotcom_user',
  ]) {
    if (names.has(important)) score += 100;
  }

  return score;
}

function mergeCookies(cookiesList) {
  const merged = new Map();

  for (const cookies of cookiesList) {
    for (const cookie of cookies) {
      const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
      merged.set(key, cookie);
    }
  }

  return Array.from(merged.values());
}

async function readCookiesFromBrowser(url, browser) {
  const processNames = { chrome: 'chrome.exe', edge: 'msedge.exe' };
  if (processNames[browser] && isProcessRunning(processNames[browser])) {
    return [];
  }

  const profiles = getBrowserProfiles(browser);
  const profileCookies = [];

  for (const profile of profiles) {
    try {
      const cookies = await readCookiesFromProfile(url, browser, profile);
      if (cookies.length > 0) {
        profileCookies.push(cookies);
      }
    } catch (err) {
      console.warn(`[cookie-sync] 读取 ${browser}/${profile} 失败:`, err.message);
    }
  }

  if (profileCookies.length === 0) {
    return [];
  }

  if (profileCookies.length === 1) {
    return profileCookies[0];
  }

  const scored = profileCookies
    .map((cookies) => ({ cookies, score: scoreCookies(cookies) }))
    .sort((a, b) => b.score - a.score);

  if (scored[0].score >= 100) {
    return scored[0].cookies;
  }

  return mergeCookies(profileCookies);
}

function buildCookieUrl(cookie) {
  const secure = Boolean(cookie.Secure);
  const domain = String(cookie.domain || '').replace(/^\./, '');
  const cookiePath = cookie.path || '/';
  return `${secure ? 'https' : 'http'}://${domain}${cookiePath}`;
}

async function setCookiesOnSession(targetSession, cookies) {
  let imported = 0;
  const failures = [];

  for (const cookie of cookies) {
    if (!cookie.name) continue;

    const value = sanitizeCookieValue(cookie.value);
    if (!value) continue;

    const details = {
      url: buildCookieUrl(cookie),
      name: cookie.name,
      value,
      path: cookie.path || '/',
      secure: Boolean(cookie.Secure),
      httpOnly: Boolean(cookie.HttpOnly),
      expirationDate: cookie.expires > 0 ? cookie.expires : chromiumToUnix(cookie.expires),
      sameSite: mapSameSite(cookie.sameSite),
    };

    if (!cookie.hostOnly && !cookie.name.startsWith('__Host-')) {
      details.domain = cookie.domain;
    }

    try {
      await targetSession.cookies.set(details);
      imported += 1;
    } catch (err) {
      failures.push({ name: cookie.name, error: err.message });
    }
  }

  if (typeof targetSession.cookies.flushStore === 'function') {
    await targetSession.cookies.flushStore();
  }

  return { imported, failures };
}

async function importCookiesToSession(targetSession, url, source = 'auto') {
  if (process.platform !== 'win32') {
    return { imported: 0, browsers: [], skipped: '仅支持 Windows 同步 Chrome/Edge Cookie' };
  }

  const browsers = resolveBrowserSources(source);
  if (browsers.length === 0) {
    return { imported: 0, browsers: [], skipped: '未找到 Chrome 或 Edge 的 Cookie 数据' };
  }

  let readCount = 0;
  const usedBrowsers = [];
  let failures = [];
  let message = '';

  for (const browser of browsers) {
    const cdpResult = await readCookiesFromBrowserViaCdp(url, browser);
    if (cdpResult.blocked) {
      return {
        imported: 0,
        readCount: 0,
        verified: 0,
        browsers: [],
        blocked: true,
        message: cdpResult.message,
      };
    }

    if (cdpResult.cookies?.length) {
      readCount += cdpResult.cookies.length;
      usedBrowsers.push(browser);
      const applied = await setCookiesOnSession(targetSession, cdpResult.cookies);
      failures = applied.failures;

      if (applied.imported > 0) {
        const verified = (await targetSession.cookies.get({ url })).length;
        return {
          imported: applied.imported,
          readCount,
          verified,
          browsers: usedBrowsers,
          failures: failures.slice(0, 5),
          method: 'cdp',
          profile: cdpResult.profile,
        };
      }
    }
  }

  let imported = 0;

  for (const browser of browsers) {
    let cookies = [];

    try {
      cookies = await readCookiesFromBrowser(url, browser);
    } catch (err) {
      if (browsers.length === 1) {
        throw new Error(
          /locked|busy/i.test(String(err.message))
            ? '浏览器 Cookie 数据库被占用，请关闭 Chrome/Edge 后重试'
            : err.message || '读取浏览器 Cookie 失败'
        );
      }
      continue;
    }

    readCount += cookies.length;

    if (cookies.length === 0) {
      continue;
    }

    usedBrowsers.push(browser);
    const applied = await setCookiesOnSession(targetSession, cookies);
    imported += applied.imported;
    failures = applied.failures;

    if (imported > 0) {
      break;
    }
  }

  if (imported === 0 && !message) {
    message =
      '未能读取有效登录 Cookie。Chrome 127+ 使用了新加密，请关闭 Chrome 后点击地址栏旁的同步按钮，或在应用内登录一次（会记住）';
  }

  const verified = imported > 0 ? (await targetSession.cookies.get({ url })).length : 0;

  return {
    imported,
    readCount,
    verified,
    browsers: usedBrowsers,
    failures: failures.slice(0, 5),
    message,
    method: imported > 0 ? 'database' : 'none',
  };
}

module.exports = {
  BROWSER_PARTITION,
  listAvailableBrowsers,
  importCookiesToSession,
  readCookiesFromBrowser,
};
