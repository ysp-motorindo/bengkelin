// Test-harness only: loaded into windows the e2e suite opens from the main
// process to invoke IPC without the production bridge. Never shipped.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rawInvoke', (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args),
);
