const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('miztraceDesktop', {
  chooseDirectories: () => ipcRenderer.invoke('miztrace:choose-directories'),
  updates: {
    state: () => ipcRenderer.invoke('miztrace:update-state'),
    check: () => ipcRenderer.invoke('miztrace:update-check'),
    download: () => ipcRenderer.invoke('miztrace:update-download'),
    install: () => ipcRenderer.invoke('miztrace:update-install'),
    setAutoCheck: (enabled) => ipcRenderer.invoke('miztrace:update-preferences', enabled),
    onOpen: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('miztrace:update-open', listener);
      return () => ipcRenderer.removeListener('miztrace:update-open', listener);
    },
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('miztrace:update-state', listener);
      return () => ipcRenderer.removeListener('miztrace:update-state', listener);
    },
  },
});
