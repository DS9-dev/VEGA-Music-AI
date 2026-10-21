import { contextBridge, ipcRenderer } from 'electron';
import type { MusicApi } from '../src/shared/api';

const on = <T>(channel: string) => (cb: (v: T) => void) => {
  const h = (_: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => { ipcRenderer.removeListener(channel, h); };
};

const api: MusicApi = {
  platform: process.platform,
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    reset: () => ipcRenderer.invoke('settings:reset'),
    pickFolder: (current) => ipcRenderer.invoke('settings:pickFolder', current),
  },
  status: () => ipcRenderer.invoke('status'),
  ace: { start: () => ipcRenderer.invoke('ace:start'), stop: () => ipcRenderer.invoke('ace:stop') },
  lm: { models: () => ipcRenderer.invoke('lm:models') },
  lyrics: {
    generate: (p) => ipcRenderer.invoke('lyrics:generate', p),
    cancel: () => ipcRenderer.invoke('lyrics:cancel'),
    onChunk: on('lyrics:chunk'),
  },
  job: {
    start: (p, title, lyrics) => ipcRenderer.invoke('job:start', p, title, lyrics),
    cancel: () => ipcRenderer.invoke('job:cancel'),
    reset: () => ipcRenderer.invoke('job:reset'),
    get: () => ipcRenderer.invoke('job:get'),
    onUpdate: on('job:update'),
  },
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    readAudio: (id, file) => ipcRenderer.invoke('library:readAudio', id, file),
    update: (id, patch) => ipcRenderer.invoke('library:update', id, patch),
    remove: (id) => ipcRenderer.invoke('library:remove', id),
    reveal: (id, file) => ipcRenderer.invoke('library:reveal', id, file),
    openRoot: () => ipcRenderer.invoke('library:openRoot'),
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },
};

contextBridge.exposeInMainWorld('api', api);
