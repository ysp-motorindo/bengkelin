import { contextBridge } from 'electron';
import type { BengkelinApi } from './shared/bridge';

// The only surface the renderer sees. Feature tasks add named, validated
// methods here; nothing generic (no raw ipcRenderer) is ever exposed.
const api: BengkelinApi = Object.freeze({});

contextBridge.exposeInMainWorld('bengkelin', api);
