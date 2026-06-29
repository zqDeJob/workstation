const state = {
  tabs: [],
  activeTabId: null,
  activeView: 'welcome',
  activeShell: null,
  terminals: {},
  terminalUnsubs: {},
  config: null,
  editingWebsites: [],
  editingApps: [],
  currentTheme: null,
};

const $ = (sel) => document.querySelector(sel);

function hideAllPanels() {
  $('#welcome').classList.add('hidden');
  $('#webview-container').classList.add('hidden');
  $('#terminal-container').classList.add('hidden');
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

  hideAllPanels();
  state.activeView = 'terminal';
  state.activeTabId = null;
  state.activeShell = shellType;
  updateBuiltinActive();
  renderTabs();
  $('#terminal-container').classList.remove('hidden');
  $('#tab-bar').classList.add('hidden');
  $('#terminal-label').textContent = shellType === 'git' ? 'Git Bash' : 'PowerShell';
  $('#terminal-powershell').classList.toggle('hidden', shellType !== 'powershell');
  $('#terminal-git').classList.toggle('hidden', shellType !== 'git');
  initTerminal(shellType);
}

function updateBuiltinActive() {
  document.querySelectorAll('.builtin-item').forEach((btn) => {
    const shell = btn.dataset.shell;
    const active = state.activeView === 'terminal' && state.activeShell === shell;
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
}

function createTabId() {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function openWebsite(name, url, icon = '🌐') {
  const existing = state.tabs.find((t) => t.url === url);
  if (existing) {
    showWebTab(existing.id);
    return;
  }

  const id = createTabId();
  const tab = { id, name, url, icon };
  state.tabs.push(tab);

  const webview = document.createElement('webview');
  webview.dataset.tabId = id;
  webview.src = url;
  webview.classList.add('webview');
  webview.setAttribute('allowpopups', '');
  webview.addEventListener('page-title-updated', (e) => {
    const t = state.tabs.find((x) => x.id === id);
    if (t && e.title) {
      t.name = e.title;
      renderTabs();
    }
  });

  $('#webview-container').appendChild(webview);
  showWebTab(id);
}

function closeTab(tabId, event) {
  event?.stopPropagation();

  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  state.tabs.splice(idx, 1);
  document.querySelector(`webview[data-tab-id="${tabId}"]`)?.remove();

  if (state.activeTabId === tabId) {
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

async function initTerminal(shellType) {
  const key = terminalKey(shellType);

  if (state.terminals[key]) {
    fitTerminal(key);
    return;
  }

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    theme: getTerminalTheme(),
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const containerId = shellType === 'git' ? 'terminal-git' : 'terminal-powershell';
  term.open($(`#${containerId}`));

  const terminalId = `terminal-${key}`;
  state.terminals[key] = { term, fitAddon, id: terminalId };

  const result = await window.workspace.terminalCreate({
    id: terminalId,
    cols: term.cols,
    rows: term.rows,
    shellType: key,
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
    }
  });

  state.terminalUnsubs[key] = { unsubData, unsubExit };

  term.onData((data) => {
    window.workspace.terminalInput(terminalId, data);
  });

  fitTerminal(key);

  if (!state._terminalResizeObserver) {
    state._terminalResizeObserver = new ResizeObserver(() => {
      if (state.activeShell) fitTerminal(terminalKey(state.activeShell));
    });
    state._terminalResizeObserver.observe($('#terminal-container'));
  }
}

function fitTerminal(key) {
  const entry = state.terminals[key];
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
  const gitHint = $('#git-unavailable-hint');
  if (state.config.gitAvailable) {
    gitBtn.disabled = false;
    gitBtn.classList.remove('disabled');
    gitHint.classList.add('hidden');
  } else {
    gitBtn.disabled = true;
    gitBtn.classList.add('disabled');
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

function bindEvents() {
  $('#btn-terminal-ps').addEventListener('click', () => showBuiltinTerminal('powershell'));
  $('#btn-terminal-git').addEventListener('click', () => showBuiltinTerminal('git'));

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

  $('#btn-reload').addEventListener('click', () => {
    getActiveWebview()?.reload();
  });

  $('#btn-external').addEventListener('click', () => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (tab) window.workspace.openExternal(tab.url);
  });

  window.addEventListener('beforeunload', () => {
    Object.values(state.terminals).forEach((entry) => {
      window.workspace.terminalDestroy(entry.id);
    });
    Object.values(state.terminalUnsubs).forEach(({ unsubData, unsubExit }) => {
      unsubData();
      unsubExit();
    });
  });
}

async function init() {
  state.config = await window.workspace.getConfig();
  applyTheme(state.config.currentTheme);
  renderSidebar();
  bindEvents();
  showWelcome();
}

init();
