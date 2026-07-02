const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workspace', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveWebsites: (websites) => ipcRenderer.invoke('save-websites', websites),
  saveLocalApps: (apps) => ipcRenderer.invoke('save-local-apps', apps),
  saveTheme: (themeId) => ipcRenderer.invoke('save-theme', themeId),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  registerWebPartition: (partition) => ipcRenderer.send('register-web-partition', partition),
  syncBrowserCookies: (url) => ipcRenderer.invoke('sync-browser-cookies', url),
  launchApp: (appItem) => ipcRenderer.invoke('launch-app', appItem),

  terminalCreate: (opts) => ipcRenderer.invoke('terminal-create', opts),
  terminalInput: (id, data) => ipcRenderer.send('terminal-input', { id, data }),
  terminalResize: (id, cols, rows) =>
    ipcRenderer.send('terminal-resize', { id, cols, rows }),
  terminalDestroy: (id) => ipcRenderer.send('terminal-destroy', { id }),
  getKnownFolders: () => ipcRenderer.invoke('get-known-folders'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  onTerminalData: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('terminal-data', handler);
    return () => ipcRenderer.removeListener('terminal-data', handler);
  },
  onTerminalExit: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('terminal-exit', handler);
    return () => ipcRenderer.removeListener('terminal-exit', handler);
  },
});
