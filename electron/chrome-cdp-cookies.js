const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');

const BROWSER_CONFIG = {
  chrome: {
    processName: 'chrome.exe',
    userDataDir: path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    executables: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  },
  edge: {
    processName: 'msedge.exe',
    userDataDir: path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
    executables: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
  },
};

function isProcessRunning(imageName) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /NH`, {
      encoding: 'utf8',
      windowsHide: true,
    });
    return out.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    return false;
  }
}

function findExecutable(browser) {
  const config = BROWSER_CONFIG[browser];
  if (!config) return null;

  for (const candidate of config.executables) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function listProfiles(browser) {
  const userDataDir = BROWSER_CONFIG[browser]?.userDataDir;
  if (!userDataDir || !fs.existsSync(userDataDir)) return ['Default'];

  return fs
    .readdirSync(userDataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === 'Default' || /^Profile \d+$/.test(name));
}

function waitForDevToolsPort(profileDir, timeoutMs = 15000) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('等待浏览器调试端口超时'));
        return;
      }

      if (!fs.existsSync(portFile)) return;

      try {
        const [portLine] = fs.readFileSync(portFile, 'utf8').split('\n');
        const port = Number(portLine.trim());
        if (port > 0) {
          clearInterval(timer);
          resolve(port);
        }
      } catch {
        /* retry */
      }
    }, 200);
  });
}

function cdpRequest(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);

    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (message.id !== id) return;
      ws.off('message', onMessage);
      if (message.error) {
        reject(new Error(message.error.message || 'CDP 请求失败'));
        return;
      }
      resolve(message.result);
    };

    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function connectCdp(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function mapCdpCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: !String(cookie.domain || '').startsWith('.'),
    path: cookie.path || '/',
    Secure: Boolean(cookie.secure),
    HttpOnly: Boolean(cookie.httpOnly),
    expires: cookie.expires,
    sameSite: cookie.sameSite || 'unspecified',
  };
}

async function readCookiesViaCdp(browser, url, profile = 'Default') {
  const config = BROWSER_CONFIG[browser];
  if (!config) {
    return { cookies: [], blocked: true, message: '不支持的浏览器' };
  }

  if (isProcessRunning(config.processName)) {
    return {
      cookies: [],
      blocked: true,
      message: `${browser === 'edge' ? 'Edge' : 'Chrome'} 正在运行，请先关闭所有窗口后再同步 Cookie`,
    };
  }

  const executable = findExecutable(browser);
  if (!executable) {
    return { cookies: [], blocked: false, message: `未找到 ${browser} 可执行文件` };
  }

  const profileDir = path.join(config.userDataDir, profile);
  if (!fs.existsSync(profileDir)) {
    return { cookies: [], blocked: false, message: `未找到 ${browser} 配置文件 ${profile}` };
  }

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  try {
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  } catch {
    /* ignore */
  }

  const args = [
    `--user-data-dir=${config.userDataDir}`,
    `--profile-directory=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    'about:blank',
  ];

  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: 'ignore',
  });

  let ws;

  try {
    const port = await waitForDevToolsPort(profileDir);
    ws = await connectCdp(port);
    await cdpRequest(ws, 'Network.enable');
    const result = await cdpRequest(ws, 'Network.getCookies', { urls: [url] });
    const cookies = (result?.cookies || []).map(mapCdpCookie).filter((cookie) => cookie.name && cookie.value);
    return { cookies, blocked: false };
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        await cdpRequest(ws, 'Browser.close');
      } catch {
        /* ignore */
      }
      ws.close();
    }

    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }

    try {
      if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
    } catch {
      /* ignore */
    }
  }
}

async function readCookiesFromBrowserViaCdp(url, browser) {
  const profiles = listProfiles(browser);
  let best = { cookies: [], score: 0, profile: null };

  for (const profile of profiles) {
    const result = await readCookiesViaCdp(browser, url, profile);
    if (result.blocked) {
      return result;
    }

    const score = result.cookies.length;
    if (score > best.score) {
      best = { cookies: result.cookies, score, profile };
    }
  }

  return { cookies: best.cookies, blocked: false, profile: best.profile };
}

module.exports = {
  isProcessRunning,
  readCookiesViaCdp,
  readCookiesFromBrowserViaCdp,
};
