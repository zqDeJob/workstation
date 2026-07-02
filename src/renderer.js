const state = {
  tabs: [],
  activeTabId: null,
  activeView: 'welcome',
  activeShell: null,
  terminalTabs: [],
  activeTerminalTabId: null,
  terminalCounters: { powershell: 0, git: 0 },
  terminals: {},
  terminalUnsubs: {},
  config: null,
  editingWebsites: [],
  editingApps: [],
  currentTheme: null,
  findBar: { visible: false, text: '' },
  browserPartition: 'persist:browser',
  knownFolders: {},
};

const $ = (sel) => document.querySelector(sel);

function hideAllPanels() {
  $('#welcome').classList.add('hidden');
  $('#webview-container').classList.add('hidden');
  $('#terminal-container').classList.add('hidden');
  closeFindBar();
}

function getBrowserPartition() {
  return state.browserPartition || 'persist:browser';
}

async function syncBrowserCookiesForUrl(url, { reload = false } = {}) {
  if (!url || state.config?.browser?.cookieSync === false) {
    return { ok: true, imported: 0 };
  }

  const result = await window.workspace.syncBrowserCookies(url);
  if (!result.ok && result.error) {
    console.warn('[cookie-sync]', result.error);
  } else if (result.blocked && result.message) {
    console.warn('[cookie-sync]', result.message);
  } else if (result.imported > 0) {
    console.info('[cookie-sync]', `已同步 ${result.imported} 条 Cookie`);
  }

  if (reload) {
    getActiveWebview()?.reload();
  }

  return result;
}

function updateUrlBar() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  const urlInput = $('#url-display');
  if (!tab || state.activeView !== 'web') {
    urlInput.value = '';
    return;
  }
  urlInput.value = tab.currentUrl || tab.url;
}

function updateTabUrl(tabId, url) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || !url) return;
  tab.currentUrl = url;
  if (tab.id === state.activeTabId) {
    updateUrlBar();
  }
}

async function copyCurrentUrl() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  const url = tab?.currentUrl || tab?.url;
  if (!url) return;

  try {
    await navigator.clipboard.writeText(url);
    const input = $('#url-display');
    input.classList.add('url-input--copied');
    input.title = '已复制';
    setTimeout(() => {
      input.classList.remove('url-input--copied');
      input.title = '当前页面地址，点击复制';
    }, 1200);
  } catch {
    $('#url-display').select();
    document.execCommand('copy');
  }
}

function openFindBar() {
  if (state.activeView !== 'web') return;

  state.findBar.visible = true;
  $('#find-bar').classList.remove('hidden');

  const input = $('#find-input');
  if (state.findBar.text) {
    input.value = state.findBar.text;
  }
  input.focus();
  input.select();

  if (input.value.trim()) {
    runFind(input.value.trim(), false);
  }
}

function closeFindBar() {
  if (!state.findBar.visible) return;

  state.findBar.visible = false;
  state.findBar.text = $('#find-input').value;
  $('#find-bar').classList.add('hidden');
  $('#find-count').textContent = '';
  getActiveWebview()?.stopFindInPage('clearSelection');
}

function runFind(text, findNext) {
  const wv = getActiveWebview();
  if (!wv || !text) return;

  wv.findInPage(text, {
    forward: true,
    findNext,
  });
}

function setupWebviewEvents(webview, tabId) {
  const onNavigate = (e) => updateTabUrl(tabId, e.url);

  webview.addEventListener('did-navigate', onNavigate);
  webview.addEventListener('did-navigate-in-page', onNavigate);

  webview.addEventListener('page-title-updated', (e) => {
    const t = state.tabs.find((x) => x.id === tabId);
    if (t && e.title) {
      t.name = e.title;
      renderTabs();
    }
  });

  webview.addEventListener('found-in-page', (e) => {
    if (!state.findBar.visible || e.result.finalUpdate === false) return;
    const { activeMatchOrdinal, matches } = e.result;
    if (matches === 0) {
      $('#find-count').textContent = '无结果';
    } else {
      $('#find-count').textContent = `${activeMatchOrdinal}/${matches}`;
    }
  });
}

function createWebviewElement(tab) {
  const webview = document.createElement('webview');
  const partition = getBrowserPartition();

  webview.dataset.tabId = tab.id;
  webview.classList.add('webview');
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('partition', partition);
  webview.setAttribute(
    'webpreferences',
    'contextIsolation=yes, nativeWindowOpen=yes, spellcheck=yes'
  );

  window.workspace.registerWebPartition(partition);
  setupWebviewEvents(webview, tab.id);
  return webview;
}

async function mountWebview(tab) {
  const webview = createWebviewElement(tab);
  $('#webview-container').appendChild(webview);
  await syncBrowserCookiesForUrl(tab.url);
  webview.src = tab.url;
  return webview;
}

function showWelcome() {
  hideAllPanels();
  state.activeView = 'welcome';
  state.activeTabId = null;
  state.activeShell = null;
  updateBuiltinActive();
  renderTabs();
  $('#welcome').classList.remove('hidden');
  $('#tab-bar').classList.add('hidden');
}

function showBuiltinTerminal(shellType) {
  if (shellType === 'git' && !state.config.gitAvailable) {
    alert('未检测到 Git Bash，请先安装 Git for Windows。');
    return;
  }

  openTerminalTab(shellType);
}

function ensureTerminalViewVisible() {
  hideAllPanels();
  state.activeView = 'terminal';
  state.activeTabId = null;
  updateBuiltinActive();
  renderTabs();
  $('#terminal-container').classList.remove('hidden');
  $('#tab-bar').classList.add('hidden');
}

function createTerminalTabId() {
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function shellLabel(shellType) {
  return shellType === 'git' ? 'Git Bash' : 'PowerShell';
}

function shellIcon(shellType) {
  return shellType === 'git' ? '🌿' : '⌨️';
}

function nextTerminalTitle(shellType) {
  state.terminalCounters[shellType] = (state.terminalCounters[shellType] || 0) + 1;
  return `${shellLabel(shellType)} ${state.terminalCounters[shellType]}`;
}

function openTerminalTab(shellType, { cwd } = {}) {
  if (shellType === 'git' && !state.config.gitAvailable) {
    alert('未检测到 Git Bash，请先安装 Git for Windows。');
    return;
  }

  ensureTerminalViewVisible();

  const tab = {
    id: createTerminalTabId(),
    shellType,
    title: nextTerminalTitle(shellType),
    exited: false,
    cwd: cwd || null,
  };

  state.terminalTabs.push(tab);

  const panel = document.createElement('div');
  panel.className = 'terminal-panel';
  panel.dataset.terminalTabId = tab.id;
  $('#terminal-panels').appendChild(panel);

  renderTerminalTabs();
  showTerminalTab(tab.id);
  initTerminalInstance(tab.id, shellType, panel, tab.cwd);
}

function showTerminalTab(tabId) {
  state.activeTerminalTabId = tabId;
  const tab = state.terminalTabs.find((t) => t.id === tabId);
  state.activeShell = tab?.shellType || null;

  document.querySelectorAll('.terminal-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.terminalTabId === tabId);
  });

  renderTerminalTabs();
  updateBuiltinActive();

  const entry = state.terminals[tabId];
  if (entry) {
    fitTerminal(tabId);
    entry.term.focus();
  }
}

function closeTerminalTab(tabId, event) {
  event?.stopPropagation();

  const idx = state.terminalTabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  destroyTerminalInstance(tabId);
  state.terminalTabs.splice(idx, 1);
  document.querySelector(`.terminal-panel[data-terminal-tab-id="${tabId}"]`)?.remove();

  if (state.activeTerminalTabId === tabId) {
    if (state.terminalTabs.length > 0) {
      showTerminalTab(state.terminalTabs[Math.max(0, idx - 1)].id);
    } else {
      state.activeTerminalTabId = null;
      state.activeShell = null;
      showWelcome();
    }
  } else {
    renderTerminalTabs();
  }
}

function renderTerminalTabs() {
  const tabsEl = $('#terminal-tabs');
  tabsEl.innerHTML = '';

  state.terminalTabs.forEach((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `terminal-tab${tab.id === state.activeTerminalTabId ? ' active' : ''}${
      tab.exited ? ' exited' : ''
    }`;
    btn.innerHTML = `
      <span>${shellIcon(tab.shellType)}</span>
      <span class="terminal-tab-title">${escapeHtml(tab.title)}</span>
      <span class="terminal-tab-close" data-close="${tab.id}">×</span>
    `;
    btn.addEventListener('click', () => showTerminalTab(tab.id));
    btn.querySelector('.terminal-tab-close').addEventListener('click', (e) =>
      closeTerminalTab(tab.id, e)
    );
    tabsEl.appendChild(btn);
  });
}

function destroyTerminalInstance(tabId) {
  const entry = state.terminals[tabId];
  if (entry) {
    window.workspace.terminalDestroy(entry.id);
    try {
      entry.term.dispose();
    } catch {
      /* ignore */
    }
    delete state.terminals[tabId];
  }

  const unsubs = state.terminalUnsubs[tabId];
  if (unsubs) {
    unsubs.unsubData();
    unsubs.unsubExit();
    delete state.terminalUnsubs[tabId];
  }
}

function setupTerminalKeyHandler(term) {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;

    const mod = event.ctrlKey || event.metaKey;

    if (mod && event.shiftKey && (event.key === 'C' || event.key === 'c')) {
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
    }

    if (mod && event.shiftKey && (event.key === 'V' || event.key === 'v')) {
      navigator.clipboard.readText().then((text) => term.paste(text)).catch(() => {});
      return false;
    }

    if (mod && (event.key === 'Insert' || event.code === 'Insert')) {
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
    }

    if (event.shiftKey && (event.key === 'Insert' || event.code === 'Insert')) {
      navigator.clipboard.readText().then((text) => term.paste(text)).catch(() => {});
      return false;
    }

    return true;
  });
}

function isTypingContext() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function handleTerminalShortcuts(e) {
  if (isTypingContext()) return;

  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.shiftKey && (e.code === 'Backquote' || e.key === '`' || e.key === '~')) {
    e.preventDefault();
    const shellType = state.activeShell || 'powershell';
    openTerminalTab(shellType);
    return;
  }

  if (mod && e.shiftKey && (e.key === 'T' || e.key === 't')) {
    e.preventDefault();
    openTerminalTab(state.activeShell || 'powershell');
    return;
  }

  if (mod && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
    e.preventDefault();
    if (state.activeTerminalTabId) {
      closeTerminalTab(state.activeTerminalTabId);
    }
    return;
  }

  if (mod && e.key === 'Tab') {
    e.preventDefault();
    switchTerminalTab(e.shiftKey ? -1 : 1);
    return;
  }

  if (mod && e.key === 'PageDown') {
    e.preventDefault();
    switchTerminalTab(1);
    return;
  }

  if (mod && e.key === 'PageUp') {
    e.preventDefault();
    switchTerminalTab(-1);
    return;
  }

  if (mod && /^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1;
    if (state.terminalTabs[index]) {
      e.preventDefault();
      showTerminalTab(state.terminalTabs[index].id);
    }
  }
}

function switchTerminalTab(direction) {
  if (state.terminalTabs.length === 0) return;

  const currentIdx = state.terminalTabs.findIndex((t) => t.id === state.activeTerminalTabId);
  const baseIdx = currentIdx === -1 ? 0 : currentIdx;
  const nextIdx =
    (baseIdx + direction + state.terminalTabs.length) % state.terminalTabs.length;
  showTerminalTab(state.terminalTabs[nextIdx].id);
}

function updateBuiltinActive() {
  document.querySelectorAll('.builtin-item').forEach((btn) => {
    const shell = btn.dataset.shell;
    const active =
      state.activeView === 'terminal' &&
      state.terminalTabs.some((t) => t.id === state.activeTerminalTabId && t.shellType === shell);
    btn.classList.toggle('active', active);
  });
}

function showWebTab(tabId) {
  hideAllPanels();
  state.activeView = 'web';
  state.activeTabId = tabId;
  state.activeShell = null;
  updateBuiltinActive();
  renderTabs();
  $('#webview-container').classList.remove('hidden');
  $('#tab-bar').classList.remove('hidden');

  document.querySelectorAll('webview').forEach((wv) => {
    wv.classList.toggle('active', wv.dataset.tabId === tabId);
  });

  updateUrlBar();
}

function createTabId() {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function openWebsite(name, url, icon = '🌐') {
  const existing = state.tabs.find((t) => t.url === url);
  if (existing) {
    await syncBrowserCookiesForUrl(existing.currentUrl || existing.url);
    showWebTab(existing.id);
    return;
  }

  const id = createTabId();
  const tab = { id, name, url, icon, currentUrl: url };
  state.tabs.push(tab);

  showWebTab(id);
  await mountWebview(tab);
}

function closeTab(tabId, event) {
  event?.stopPropagation();

  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  state.tabs.splice(idx, 1);
  document.querySelector(`webview[data-tab-id="${tabId}"]`)?.remove();

  if (state.activeTabId === tabId) {
    closeFindBar();
    if (state.tabs.length > 0) {
      showWebTab(state.tabs[Math.max(0, idx - 1)].id);
    } else {
      showWelcome();
    }
  } else {
    renderTabs();
  }
}

function renderTabs() {
  const tabsEl = $('#tabs');
  tabsEl.innerHTML = '';

  state.tabs.forEach((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tab${tab.id === state.activeTabId ? ' active' : ''}`;
    btn.innerHTML = `
      <span class="tab-icon">${tab.icon}</span>
      <span class="tab-title">${escapeHtml(tab.name)}</span>
      <span class="tab-close" data-close="${tab.id}">×</span>
    `;
    btn.addEventListener('click', () => showWebTab(tab.id));
    btn.querySelector('.tab-close').addEventListener('click', (e) => closeTab(tab.id, e));
    tabsEl.appendChild(btn);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getActiveWebview() {
  if (!state.activeTabId) return null;
  return document.querySelector(`webview[data-tab-id="${state.activeTabId}"]`);
}

function getTerminalTheme() {
  return (
    state.currentTheme?.terminal || {
      background: '#11111b',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#45475a',
    }
  );
}

function applyTheme(theme) {
  if (!theme?.colors) return;

  state.currentTheme = theme;
  const root = document.documentElement;
  const c = theme.colors;

  root.dataset.theme = theme.id;
  root.style.setProperty('--bg-base', c.bgBase);
  root.style.setProperty('--bg-surface', c.bgSurface);
  root.style.setProperty('--bg-overlay', c.bgOverlay);
  root.style.setProperty('--border', c.border);
  root.style.setProperty('--text-primary', c.textPrimary);
  root.style.setProperty('--text-secondary', c.textSecondary);
  root.style.setProperty('--text-muted', c.textMuted);
  root.style.setProperty('--accent', c.accent);
  root.style.setProperty('--hover-bg', c.hoverBg);
  root.style.setProperty('--primary-bg', c.primaryBg);
  root.style.setProperty('--primary-fg', c.primaryFg);
  root.style.setProperty('--danger-bg', c.dangerBg);
  root.style.setProperty('--danger-text', c.dangerText);
  root.style.setProperty('--modal-backdrop', c.modalBackdrop);
  root.style.setProperty('--shadow', c.shadow);

  Object.values(state.terminals).forEach(({ term }) => {
    term.options.theme = { ...theme.terminal };
  });
}

function openThemeModal() {
  renderThemeGrid();
  $('#theme-modal').classList.remove('hidden');
  $('#theme-modal').setAttribute('aria-hidden', 'false');
}

function closeThemeModal() {
  $('#theme-modal').classList.add('hidden');
  $('#theme-modal').setAttribute('aria-hidden', 'true');
}

function renderThemeGrid() {
  const grid = $('#theme-grid');
  grid.innerHTML = '';

  state.config.themes.forEach((theme) => {
    const btn = document.createElement('button');
    const c = theme.colors;
    btn.type = 'button';
    btn.className = `theme-card${theme.id === state.config.themeId ? ' active' : ''}`;
    btn.innerHTML = `
      <div class="theme-preview" style="
        --preview-base: ${c.bgBase};
        --preview-surface: ${c.bgSurface};
        --preview-overlay: ${c.bgOverlay};
        --preview-border: ${c.border};
      ">
        <div class="theme-preview-sidebar"></div>
        <div class="theme-preview-main">
          <div class="theme-preview-bar"></div>
          <div class="theme-preview-content"></div>
        </div>
      </div>
      <span class="theme-card-name">${escapeHtml(theme.name)}</span>
    `;
    btn.addEventListener('click', () => selectTheme(theme.id));
    grid.appendChild(btn);
  });
}

async function selectTheme(themeId) {
  const result = await window.workspace.saveTheme(themeId);
  if (!result.ok) {
    alert(result.error);
    return;
  }

  state.config.themeId = themeId;
  applyTheme(result.theme);
  renderThemeGrid();
}

function terminalKey(shellType) {
  return shellType === 'git' ? 'git' : 'powershell';
}

function toGitBashPath(folderPath) {
  const normalized = folderPath.replace(/\\/g, '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) return normalized;
  return `/${match[1].toLowerCase()}/${match[2]}`;
}

function buildTerminalCdCommand(shellType, folderPath) {
  if (shellType === 'git') {
    const bashPath = toGitBashPath(folderPath);
    return `cd '${bashPath.replace(/'/g, "'\\''")}'\r`;
  }

  const psPath = folderPath.replace(/'/g, "''");
  return `Set-Location -LiteralPath '${psPath}'\r`;
}

function cdTerminal(tabId, folderPath) {
  const tab = state.terminalTabs.find((t) => t.id === tabId);
  const entry = state.terminals[tabId];
  if (!tab || !entry || tab.exited) return false;

  window.workspace.terminalInput(entry.id, buildTerminalCdCommand(tab.shellType, folderPath));
  entry.term.focus();
  return true;
}

function openFolderInTerminal(folderPath) {
  if (!folderPath) return;

  const hasActiveTerminal =
    state.activeView === 'terminal' &&
    state.activeTerminalTabId &&
    state.terminalTabs.some((t) => t.id === state.activeTerminalTabId && !t.exited);

  if (hasActiveTerminal) {
    cdTerminal(state.activeTerminalTabId, folderPath);
    return;
  }

  openTerminalTab('powershell', { cwd: folderPath });
}

async function openKnownFolder(key) {
  const folder = state.knownFolders[key];
  if (!folder?.path) {
    alert('未找到该文件夹');
    return;
  }
  openFolderInTerminal(folder.path);
}

async function pickFolderForTerminal() {
  const result = await window.workspace.pickFolder();
  if (!result.ok) {
    if (result.error) alert(result.error);
    return;
  }
  openFolderInTerminal(result.path);
}

async function initTerminalInstance(tabId, shellType, panelEl, cwd) {
  const key = terminalKey(shellType);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    theme: getTerminalTheme(),
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(panelEl);
  setupTerminalKeyHandler(term);

  const terminalId = tabId;
  state.terminals[tabId] = { term, fitAddon, id: terminalId, shellType };

  const result = await window.workspace.terminalCreate({
    id: terminalId,
    cols: term.cols,
    rows: term.rows,
    shellType: key,
    cwd,
  });

  if (!result.ok) {
    term.writeln(`\x1b[31m${result.error}\x1b[0m`);
    return;
  }

  const unsubData = window.workspace.onTerminalData(({ id, data }) => {
    if (id === terminalId) term.write(data);
  });

  const unsubExit = window.workspace.onTerminalExit(({ id }) => {
    if (id === terminalId) {
      term.writeln('\r\n\x1b[33m[终端已退出]\x1b[0m');
      const tab = state.terminalTabs.find((t) => t.id === tabId);
      if (tab) {
        tab.exited = true;
        renderTerminalTabs();
      }
    }
  });

  state.terminalUnsubs[tabId] = { unsubData, unsubExit };

  term.onData((data) => {
    window.workspace.terminalInput(terminalId, data);
  });

  fitTerminal(tabId);
  term.focus();

  if (!state._terminalResizeObserver) {
    state._terminalResizeObserver = new ResizeObserver(() => {
      if (state.activeTerminalTabId) {
        fitTerminal(state.activeTerminalTabId);
      }
    });
    state._terminalResizeObserver.observe($('#terminal-container'));
  }
}

function fitTerminal(tabId) {
  const entry = state.terminals[tabId];
  if (!entry) return;

  try {
    entry.fitAddon.fit();
    window.workspace.terminalResize(entry.id, entry.term.cols, entry.term.rows);
  } catch {
    /* ignore */
  }
}

function renderSidebar() {
  const { websites, localApps } = state.config;

  const websiteList = $('#website-list');
  websiteList.innerHTML = '';

  if (websites.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<p class="empty-hint">暂无常用网页，点击 ⚙️ 添加</p>';
    websiteList.appendChild(li);
  } else {
    websites.forEach((site) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-item';
      btn.innerHTML = `<span class="icon">${site.icon || '🌐'}</span><span>${escapeHtml(site.name)}</span>`;
      btn.addEventListener('click', () => openWebsite(site.name, site.url, site.icon));
      li.appendChild(btn);
      websiteList.appendChild(li);
    });
  }

  const gitBtn = $('#btn-terminal-git');
  const gitNewBtn = $('#btn-terminal-new-git');
  const gitHint = $('#git-unavailable-hint');
  if (state.config.gitAvailable) {
    gitBtn.disabled = false;
    gitBtn.classList.remove('disabled');
    gitNewBtn.disabled = false;
    gitNewBtn.classList.remove('disabled');
    gitHint.classList.add('hidden');
  } else {
    gitBtn.disabled = true;
    gitBtn.classList.add('disabled');
    gitNewBtn.disabled = true;
    gitNewBtn.classList.add('disabled');
    gitHint.classList.remove('hidden');
  }

  const appList = $('#local-app-list');
  appList.innerHTML = '';

  if (localApps.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<p class="empty-hint">暂无本地应用，点击 ⚙️ 添加</p>';
    appList.appendChild(li);
    return;
  }

  localApps.forEach((appItem) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `nav-item${appItem.available ? '' : ' nav-item--muted'}`;
    btn.innerHTML = `<span class="icon">${appItem.icon || '📦'}</span><span>${escapeHtml(appItem.name)}</span>`;
    btn.title = appItem.available
      ? appItem.source === 'shortcut'
        ? '来自快捷方式'
        : '来自程序路径'
      : '路径无效或文件不存在，请在设置中检查';
    btn.addEventListener('click', () => launchApp(appItem));
    li.appendChild(btn);
    appList.appendChild(li);
  });
}

async function launchApp(appItem) {
  const result = await window.workspace.launchApp(appItem);
  if (!result.ok) {
    alert(`启动失败：${result.error}`);
  }
}

function openWebsiteModal() {
  state.editingWebsites = state.config.websites.map((site) => ({ ...site }));
  renderWebsiteEditor();
  $('#website-modal').classList.remove('hidden');
  $('#website-modal').setAttribute('aria-hidden', 'false');
}

function closeWebsiteModal() {
  $('#website-modal').classList.add('hidden');
  $('#website-modal').setAttribute('aria-hidden', 'true');
}

function openAppsModal() {
  state.editingApps = state.config.localApps.map((app) => ({
    id: app.id,
    name: app.name,
    icon: app.icon,
    path: app.path || '',
  }));
  renderAppsEditor();
  $('#apps-modal').classList.remove('hidden');
  $('#apps-modal').setAttribute('aria-hidden', 'false');
}

function closeAppsModal() {
  $('#apps-modal').classList.add('hidden');
  $('#apps-modal').setAttribute('aria-hidden', 'true');
}

function renderWebsiteEditor() {
  const list = $('#website-editor-list');
  const max = state.config.maxWebsites;
  list.innerHTML = '';

  state.editingWebsites.forEach((site, index) => {
    const li = document.createElement('li');
    li.className = 'editor-item';
    li.innerHTML = `
      <div class="editor-fields">
        <input class="input" type="text" data-field="icon" value="${escapeHtml(site.icon || '🌐')}" maxlength="4" placeholder="图标" />
        <input class="input" type="text" data-field="name" value="${escapeHtml(site.name)}" placeholder="名称" />
        <input class="input input--wide" type="url" data-field="url" value="${escapeHtml(site.url)}" placeholder="https://..." />
      </div>
      <button class="btn-danger" type="button" data-remove="${index}" title="删除">删除</button>
    `;

    li.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => {
        site[input.dataset.field] = input.value;
      });
    });

    li.querySelector('[data-remove]').addEventListener('click', () => {
      state.editingWebsites.splice(index, 1);
      renderWebsiteEditor();
    });

    list.appendChild(li);
  });

  $('#editor-count').textContent = `${state.editingWebsites.length}/${max}`;
  $('#btn-add-website').disabled = state.editingWebsites.length >= max;
}

function renderAppsEditor() {
  const list = $('#apps-editor-list');
  list.innerHTML = '';

  state.editingApps.forEach((appItem, index) => {
    const li = document.createElement('li');
    li.className = 'editor-item editor-item--apps';
    li.innerHTML = `
      <div class="editor-fields editor-fields--apps">
        <input class="input" type="text" data-field="icon" value="${escapeHtml(appItem.icon || '📦')}" maxlength="4" placeholder="图标" />
        <input class="input" type="text" data-field="name" value="${escapeHtml(appItem.name)}" placeholder="应用名称" />
        <input class="input input--full" type="text" data-field="path" value="${escapeHtml(appItem.path)}" placeholder="启动路径，如 D:\\software\\cursor\\Cursor.exe" />
      </div>
      <button class="btn-danger" type="button" data-remove="${index}" title="删除">删除</button>
    `;

    li.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => {
        appItem[input.dataset.field] = input.value;
      });
    });

    li.querySelector('[data-remove]').addEventListener('click', () => {
      state.editingApps.splice(index, 1);
      renderAppsEditor();
    });

    list.appendChild(li);
  });

  $('#apps-editor-count').textContent = `${state.editingApps.length} 个应用`;
}

function addWebsiteRow() {
  if (state.editingWebsites.length >= state.config.maxWebsites) {
    alert(`最多只能添加 ${state.config.maxWebsites} 个常用网页`);
    return;
  }

  state.editingWebsites.push({
    id: `site-${Date.now()}`,
    name: '',
    url: 'https://',
    icon: '🌐',
  });
  renderWebsiteEditor();
}

function addAppRow() {
  state.editingApps.push({
    id: `app-${Date.now()}`,
    name: '',
    icon: '📦',
    path: '',
  });
  renderAppsEditor();
}

async function saveWebsites() {
  const payload = state.editingWebsites.map((site) => ({
    id: site.id,
    name: site.name.trim(),
    url: site.url.trim(),
    icon: site.icon.trim() || '🌐',
  }));

  const result = await window.workspace.saveWebsites(payload);
  if (!result.ok) {
    alert(result.error);
    return;
  }

  state.config.websites = result.websites;
  renderSidebar();
  closeWebsiteModal();
}

async function saveApps() {
  const payload = state.editingApps.map((appItem) => ({
    id: appItem.id,
    name: appItem.name.trim(),
    icon: appItem.icon.trim() || '📦',
    path: appItem.path.trim(),
  }));

  const result = await window.workspace.saveLocalApps(payload);
  if (!result.ok) {
    alert(result.error);
    return;
  }

  state.config.localApps = result.localApps;
  renderSidebar();
  closeAppsModal();
}

function updateTerminalFolderButtons() {
  const mapping = {
    desktop: '#btn-terminal-folder-desktop',
    documents: '#btn-terminal-folder-documents',
    downloads: '#btn-terminal-folder-downloads',
  };

  for (const [key, selector] of Object.entries(mapping)) {
    const btn = $(selector);
    if (!btn) continue;
    const folder = state.knownFolders[key];
    btn.disabled = !folder?.path;
    btn.title = folder?.path ? `打开${folder.label}` : '文件夹不可用';
  }
}

function bindEvents() {
  $('#btn-terminal-ps').addEventListener('click', () => showBuiltinTerminal('powershell'));
  $('#btn-terminal-git').addEventListener('click', () => showBuiltinTerminal('git'));
  $('#btn-terminal-new-ps').addEventListener('click', () => openTerminalTab('powershell'));
  $('#btn-terminal-new-git').addEventListener('click', () => openTerminalTab('git'));
  $('#btn-terminal-folder-desktop').addEventListener('click', () => openKnownFolder('desktop'));
  $('#btn-terminal-folder-documents').addEventListener('click', () => openKnownFolder('documents'));
  $('#btn-terminal-folder-downloads').addEventListener('click', () => openKnownFolder('downloads'));
  $('#btn-terminal-folder-pick').addEventListener('click', pickFolderForTerminal);

  $('#btn-manage-websites').addEventListener('click', openWebsiteModal);
  $('#btn-add-website').addEventListener('click', addWebsiteRow);
  $('#btn-save-websites').addEventListener('click', saveWebsites);

  $('#btn-manage-apps').addEventListener('click', openAppsModal);
  $('#btn-add-app').addEventListener('click', addAppRow);
  $('#btn-save-apps').addEventListener('click', saveApps);

  $('#btn-theme').addEventListener('click', openThemeModal);

  document.querySelectorAll('[data-close-modal="website"]').forEach((el) => {
    el.addEventListener('click', closeWebsiteModal);
  });

  document.querySelectorAll('[data-close-modal="apps"]').forEach((el) => {
    el.addEventListener('click', closeAppsModal);
  });

  document.querySelectorAll('[data-close-modal="theme"]').forEach((el) => {
    el.addEventListener('click', closeThemeModal);
  });

  $('#btn-find').addEventListener('click', openFindBar);

  $('#btn-copy-url').addEventListener('click', copyCurrentUrl);
  $('#url-display').addEventListener('click', copyCurrentUrl);

  $('#btn-sync-cookies').addEventListener('click', async () => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    const url = tab?.currentUrl || tab?.url;
    if (!url) return;

    const result = await syncBrowserCookiesForUrl(url, { reload: true });
    if (!result.ok) {
      alert(`同步失败：${result.error || '未知错误'}`);
      return;
    }
    if (result.blocked && result.message) {
      alert(result.message);
      $('#url-display').title = result.message;
      return;
    }
    if (result.imported > 0) {
      const source = result.browsers?.join('/') || '浏览器';
      $('#url-display').title = `已从 ${source} 同步 ${result.imported} 条 Cookie`;
      return;
    }
    if (result.skipped) {
      $('#url-display').title = '浏览器 Cookie 同步已关闭';
      return;
    }
    alert(
      result.message ||
        '未找到可同步的登录 Cookie。请关闭 Chrome 后重试，或在应用内登录一次（之后会自动记住）'
    );
    $('#url-display').title = result.message || '未同步到登录 Cookie';
  });

  $('#find-input').addEventListener('input', (e) => {
    const text = e.target.value.trim();
    state.findBar.text = e.target.value;
    if (!text) {
      $('#find-count').textContent = '';
      getActiveWebview()?.stopFindInPage('clearSelection');
      return;
    }
    runFind(text, false);
  });

  $('#find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind(e.target.value.trim(), true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
    }
  });

  $('#btn-find-prev').addEventListener('click', () => {
    const text = $('#find-input').value.trim();
    if (text) {
      getActiveWebview()?.findInPage(text, { forward: false, findNext: true });
    }
  });

  $('#btn-find-next').addEventListener('click', () => {
    const text = $('#find-input').value.trim();
    if (text) runFind(text, true);
  });

  $('#btn-find-close').addEventListener('click', closeFindBar);

  $('#btn-reload').addEventListener('click', async () => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    const url = tab?.currentUrl || tab?.url;
    if (url) {
      await syncBrowserCookiesForUrl(url);
    }
    getActiveWebview()?.reload();
  });

  $('#btn-external').addEventListener('click', () => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    const url = tab?.currentUrl || tab?.url;
    if (url) window.workspace.openExternal(url);
  });

  window.addEventListener('keydown', (e) => {
    if (state.activeView === 'web') {
      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        openFindBar();
        return;
      }

      if (e.key === 'Escape' && state.findBar.visible) {
        e.preventDefault();
        closeFindBar();
      }
      return;
    }

    if (state.activeView === 'terminal') {
      handleTerminalShortcuts(e);
    }
  });

  window.addEventListener('beforeunload', () => {
    Object.keys(state.terminals).forEach((tabId) => {
      destroyTerminalInstance(tabId);
    });
  });
}

async function init() {
  state.config = await window.workspace.getConfig();
  state.knownFolders = await window.workspace.getKnownFolders();
  state.browserPartition = state.config.browser?.partition || 'persist:browser';
  updateTerminalFolderButtons();
  applyTheme(state.config.currentTheme);
  renderSidebar();
  bindEvents();
  showWelcome();
}

init();
