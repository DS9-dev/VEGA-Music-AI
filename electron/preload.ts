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
  voices: {
    list: () => ipcRenderer.invoke('voices:list'),
    pickSources: () => ipcRenderer.invoke('voices:pickSources'),
    create: (spec) => ipcRenderer.invoke('voices:create', spec),
    retrain: (id, profile) => ipcRenderer.invoke('voices:retrain', id, profile),
    rename: (id, name) => ipcRenderer.invoke('voices:rename', id, name),
    remove: (id) => ipcRenderer.invoke('voices:remove', id),
    reveal: (id) => ipcRenderer.invoke('voices:reveal', id),
    readAudio: (id) => ipcRenderer.invoke('voices:readAudio', id),
    exportVoice: (id) => ipcRenderer.invoke('voices:export', id),
    importVoice: () => ipcRenderer.invoke('voices:import'),
    check: () => ipcRenderer.invoke('voices:check'),
    revoice: (trackId, variant, voiceId, shift) => ipcRenderer.invoke('voices:revoice', trackId, variant, voiceId, shift),
    openRoot: () => ipcRenderer.invoke('voices:openRoot'),
  },
  songs: {
    list: () => ipcRenderer.invoke('songs:list'),
    pick: () => ipcRenderer.invoke('songs:pick'),
    importSong: (spec) => ipcRenderer.invoke('songs:import', spec),
    update: (id, patch) => ipcRenderer.invoke('songs:update', id, patch),
    remove: (id) => ipcRenderer.invoke('songs:remove', id),
    reveal: (id) => ipcRenderer.invoke('songs:reveal', id),
    readAudio: (id, which) => ipcRenderer.invoke('songs:readAudio', id, which),
    rewrite: (id, spec) => ipcRenderer.invoke('songs:rewrite', id, spec),
    cancelRewrite: () => ipcRenderer.invoke('songs:cancelRewrite'),
    onChunk: on('songs:chunk'),
    cleanup: (id) => ipcRenderer.invoke('songs:cleanup', id),
    analyzeStyle: (id) => ipcRenderer.invoke('songs:analyzeStyle', id),
    remake: (spec) => ipcRenderer.invoke('songs:remake', spec),
    openRoot: () => ipcRenderer.invoke('songs:openRoot'),
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },
};

contextBridge.exposeInMainWorld('api', api);
