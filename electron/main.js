const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync, execFileSync } = require('child_process');
const pty = require('node-pty');

const MAX_WEBSITES = 8;
let mainWindow = null;
const terminals = new Map();

const configDir = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'config');
  }
  return path.join(__dirname, '..', 'config');
};

function focusScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scripts', 'focus-or-launch.ps1');
  }
  return path.join(__dirname, 'focus-or-launch.ps1');
}
const userWebsitesPath = () => path.join(app.getPath('userData'), 'websites.json');
const userLocalAppsPath = () => path.join(app.getPath('userData'), 'local-apps.json');
const userSettingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const desktopDir = () => path.join(os.homedir(), 'Desktop');

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function ensureUserWebsites() {
  const userPath = userWebsitesPath();
  if (!fs.existsSync(userPath)) {
    const defaults = readJson(path.join(configDir(), 'websites.default.json'), []);
    writeJson(userPath, defaults);
  }
}

function loadWebsites() {
  ensureUserWebsites();
  const sites = readJson(userWebsitesPath(), []);
  return sites.slice(0, MAX_WEBSITES);
}

function saveWebsites(websites) {
  if (!Array.isArray(websites)) {
    return { ok: false, error: '数据格式无效' };
  }
  if (websites.length > MAX_WEBSITES) {
    return { ok: false, error: `最多只能保存 ${MAX_WEBSITES} 个常用网页` };
  }

  const normalized = websites.map((site, index) => {
    const url = String(site.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`第 ${index + 1} 项网址必须以 http:// 或 https:// 开头`);
    }
    return {
      id: site.id || `site-${Date.now()}-${index}`,
      name: String(site.name || '').trim() || new URL(url).hostname,
      url,
      icon: String(site.icon || '🌐').trim() || '🌐',
    };
  });

  writeJson(userWebsitesPath(), normalized);
  return { ok: true, websites: normalized };
}

function ensureUserLocalApps() {
  const userPath = userLocalAppsPath();
  if (!fs.existsSync(userPath)) {
    const defaults = readJson(path.join(configDir(), 'local-apps.default.json'), []);
    writeJson(userPath, defaults);
  }
}

function normalizeAppItem(item) {
  let pathValue = String(item.path || '').trim();
  const legacyShortcut = String(item.desktopShortcut || '').trim();

  if (!pathValue && legacyShortcut) {
    pathValue = path.join(desktopDir(), legacyShortcut);
  }

  return {
    id: item.id,
    name: item.name,
    icon: item.icon || '📦',
    path: pathValue,
  };
}

function loadLocalAppsRaw() {
  ensureUserLocalApps();
  const raw = readJson(userLocalAppsPath(), []);
  const normalized = raw.map(normalizeAppItem);
  const needsMigration = raw.some((item) => item.desktopShortcut);

  if (needsMigration) {
    writeJson(userLocalAppsPath(), normalized);
  }

  return normalized;
}

function resolveLaunchPath(item) {
  const pathValue = String(item.path || '').trim();

  if (!pathValue || !fs.existsSync(pathValue)) {
    return {
      launchPath: null,
      available: false,
      source: 'missing',
    };
  }

  return {
    launchPath: pathValue,
    available: true,
    source: pathValue.toLowerCase().endsWith('.lnk') ? 'shortcut' : 'exe',
  };
}

function resolveLocalApps() {
  return loadLocalAppsRaw().map((item) => {
    const resolved = resolveLaunchPath(item);
    return {
      id: item.id,
      name: item.name,
      icon: item.icon || '📦',
      path: item.path || '',
      ...resolved,
    };
  });
}

function saveLocalApps(apps) {
  if (!Array.isArray(apps)) {
    return { ok: false, error: '数据格式无效' };
  }

  const normalized = apps.map((item, index) => {
    const name = String(item.name || '').trim();
    const pathValue = String(item.path || '').trim();

    if (!name) {
      throw new Error(`第 ${index + 1} 项名称不能为空`);
    }
    if (!pathValue) {
      throw new Error(`第 ${index + 1} 项需填写启动路径`);
    }

    return {
      id: item.id || `app-${Date.now()}-${index}`,
      name,
      icon: String(item.icon || '📦').trim() || '📦',
      path: pathValue,
    };
  });

  writeJson(userLocalAppsPath(), normalized);
  return { ok: true, localApps: resolveLocalApps() };
}
function resolveExecutablePath(launchPath) {
  if (!launchPath) return null;

  if (launchPath.toLowerCase().endsWith('.lnk')) {
    try {
      const escaped = launchPath.replace(/'/g, "''");
      const script = `(New-Object -ComObject WScript.Shell).CreateShortcut('${escaped}').TargetPath`;
      return execSync(`powershell -NoProfile -Command "${script}"`, {
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
    } catch {
      return null;
    }
  }

  return launchPath;
}

function focusOrLaunchApp(launchPath) {
  const exePath = resolveExecutablePath(launchPath) || launchPath;

  if (process.platform !== 'win32') {
    const error = shell.openPath(launchPath);
    return error ? { ok: false, error } : { ok: true, action: 'launched' };
  }

  try {
    const scriptPath = focusScriptPath();
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-LaunchPath',
        launchPath,
        '-ExePath',
        exePath,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    ).trim();

    return {
      ok: true,
      action: output.includes('focused') ? 'focused' : 'launched',
    };
  } catch (err) {
    const error = shell.openPath(launchPath);
    return error
      ? { ok: false, error: error || err.message }
      : { ok: true, action: 'launched' };
  }
}

function findGitBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\git-bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    const result = execSync('where git', { encoding: 'utf-8', windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    if (result) {
      const gitRoot = path.dirname(path.dirname(result));
      const bashPath = path.join(gitRoot, 'bin', 'bash.exe');
      if (fs.existsSync(bashPath)) return bashPath;
    }
  } catch {
    /* git not in PATH */
  }

  return null;
}

function getShellConfig(shellType) {
  if (shellType === 'git') {
    const gitBash = findGitBash();
    if (!gitBash) return null;
    return { shellPath: gitBash, args: ['--login', '-i'] };
  }

  return {
    shellPath:
      process.env.COMSPEC ||
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [],
  };
}

function loadThemesConfig() {
  return readJson(path.join(configDir(), 'themes.json'), { default: 'mocha', themes: [] });
}

function getThemeById(themeId) {
  const { themes, default: defaultTheme } = loadThemesConfig();
  return themes.find((theme) => theme.id === themeId) || themes.find((theme) => theme.id === defaultTheme);
}

function loadThemeId() {
  const { default: defaultTheme, themes } = loadThemesConfig();
  const settings = readJson(userSettingsPath(), {});
  const themeId = settings.theme || defaultTheme;
  return themes.some((theme) => theme.id === themeId) ? themeId : defaultTheme;
}

function saveThemeId(themeId) {
  const { themes } = loadThemesConfig();
  if (!themes.some((theme) => theme.id === themeId)) {
    return { ok: false, error: '无效主题' };
  }

  const settings = readJson(userSettingsPath(), {});
  writeJson(userSettingsPath(), { ...settings, theme: themeId });
  return { ok: true, theme: getThemeById(themeId) };
}

function createWindow() {
  const theme = getThemeById(loadThemeId());

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'AI Workspace',
    backgroundColor: theme?.windowBg || '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

app.whenReady().then(() => {
  ensureUserWebsites();
  ensureUserLocalApps();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  terminals.forEach((term) => {
    try {
      term.kill();
    } catch {
      /* ignore */
    }
  });
  terminals.clear();

  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-config', () => {
  const themeId = loadThemeId();
  return {
    maxWebsites: MAX_WEBSITES,
    websites: loadWebsites(),
    localApps: resolveLocalApps(),
    gitAvailable: Boolean(findGitBash()),
    themes: loadThemesConfig().themes,
    themeId,
    currentTheme: getThemeById(themeId),
  };
});

ipcMain.handle('save-websites', (_event, websites) => {
  try {
    return saveWebsites(websites);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-local-apps', (_event, apps) => {
  try {
    return saveLocalApps(apps);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-theme', (_event, themeId) => {
  const result = saveThemeId(themeId);
  if (result.ok && mainWindow && result.theme) {
    mainWindow.setBackgroundColor(result.theme.windowBg);
  }
  return result;
});

ipcMain.handle('open-external', (_event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('launch-app', (_event, appItem) => {
  const launchPath = appItem.launchPath;
  if (!launchPath) {
    return { ok: false, error: '未找到应用，请检查启动路径或桌面快捷方式' };
  }

  return focusOrLaunchApp(launchPath);
});

ipcMain.handle('terminal-create', (_event, { id, cols, rows, shellType }) => {
  if (terminals.has(id)) {
    return { ok: true };
  }

  const shellConfig = getShellConfig(shellType || 'powershell');
  if (!shellConfig) {
    return { ok: false, error: '未检测到 Git Bash，请先安装 Git for Windows' };
  }

  const term = pty.spawn(shellConfig.shellPath, shellConfig.args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: process.env,
  });

  terminals.set(id, term);

  term.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', { id, data });
    }
  });

  term.onExit(() => {
    terminals.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exit', { id });
    }
  });

  return { ok: true };
});

ipcMain.on('terminal-input', (_event, { id, data }) => {
  const term = terminals.get(id);
  if (term) term.write(data);
});

ipcMain.on('terminal-resize', (_event, { id, cols, rows }) => {
  const term = terminals.get(id);
  if (term) {
    try {
      term.resize(cols, rows);
    } catch {
      /* ignore resize errors during init */
    }
  }
});

ipcMain.on('terminal-destroy', (_event, { id }) => {
  const term = terminals.get(id);
  if (term) {
    try {
      term.kill();
    } catch {
      /* ignore */
    }
    terminals.delete(id);
  }
});
