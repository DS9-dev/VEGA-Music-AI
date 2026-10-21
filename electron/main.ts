import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AceClient, AceProcess } from './ace';
import { Generator, generateLyrics } from './generation';
import { Library } from './library';
import { LmStudio } from './lmstudio';
import { defaultSettings, SettingsStore } from './settings';
import type { BackendStatus, Settings, Track, TrackParams } from '../src/shared/types';

/** Папка проекта: в режиме разработки — исходники, в собранном exe — путь из resources/root.json. */
function resolveRoot(): string {
  if (!app.isPackaged) return app.getAppPath();
  try {
    const r = JSON.parse(readFileSync(join(process.resourcesPath, 'root.json'), 'utf8')).root;
    if (r && existsSync(r)) return r;
  } catch { /* exe перенесли на другой компьютер */ }
  return dirname(process.execPath);
}
const appRoot = resolveRoot();
const dataDir = join(appRoot, 'data');
const settings = new SettingsStore(join(dataDir, 'settings.json'), defaultSettings(appRoot));
const ace = new AceClient(() => settings.get().aceEndpoint);
const aceProc = new AceProcess();
const lm = new LmStudio(() => settings.get().lmEndpoint);
const library = new Library(() => settings.get().libraryPath);

let win: BrowserWindow | null = null;
let aceStarting: Promise<void> | null = null;
let lyricsAbort: AbortController | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Убедиться, что ACE-Step запущен и модели загружены. При необходимости запускает его сам. */
async function ensureAce(status: (msg: string, starting: boolean) => void = () => {}, signal?: AbortSignal, force = false): Promise<void> {
  if (!(await ace.isOnline())) {
    if (!aceStarting) {
      const s = settings.get();
      if (!force && !s.aceAutoStart && !aceProc.owned) throw new Error('ACE-Step не запущен. Запустите его или включите автозапуск в настройках.');
      aceStarting = (async () => {
        aceProc.start(s.aceRuntimePath, s.aceEndpoint, s.aceLmModel, join(dataDir, 'logs', 'ace.log'));
        const deadline = Date.now() + 6 * 60_000;
        while (Date.now() < deadline) {
          await sleep(2000);
          if (await ace.isOnline()) return;
          if (!aceProc.owned) throw new Error(`ACE-Step завершился при запуске. Подробности в ${join(dataDir, 'logs', 'ace.log')}`);
        }
        aceProc.stop();
        throw new Error('ACE-Step не запустился за 6 минут');
      })().finally(() => { aceStarting = null; });
    }
    status('Запускаем ACE-Step… Первый запуск занимает 1–3 минуты', true);
    while (aceStarting) {
      if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
      await Promise.race([aceStarting, sleep(500)]);
    }
    if (!(await ace.isOnline())) throw new Error('ACE-Step не отвечает');
  }
  const h = await ace.health().catch(() => ({}));
  if (h && h.models_initialized === false) {
    const s = settings.get();
    status('Загружаем модели ACE-Step в видеопамять…', true);
    await ace.init(s.aceModel, s.aceLmModel);
  }
}

const generator = new Generator({
  ace,
  library,
  settings: () => settings.get(),
  ensureAce,
  unloadLlm: async () => { await lm.unload(settings.get().lyricsModel); },
  saveCalibration: (variants, secPerSec) => {
    const s = settings.get();
    const key = String(variants) as '1' | '2';
    const next = Math.min(5, Math.max(0.1, s.calibration[key] * 0.6 + secPerSec * 0.4));
    settings.set({ calibration: { ...s.calibration, [key]: Number(next.toFixed(3)) } });
  },
  onUpdate: (state) => {
    win?.webContents.send('job:update', state);
    if (!win) return;
    if (['preparing', 'starting', 'generating', 'saving'].includes(state.phase)) win.setProgressBar(Math.max(0.02, state.progress));
    else win.setProgressBar(-1);
    if (state.phase === 'done' || state.phase === 'error') {
      if (!win.isFocused()) {
        win.flashFrame(true);
        if (Notification.isSupported()) {
          new Notification({
            title: state.phase === 'done' ? 'Трек готов' : 'Ошибка генерации',
            body: state.phase === 'done' ? state.title : state.error ?? '',
          }).show();
        }
      }
    }
  },
});

async function status(): Promise<BackendStatus> {
  const [aceOk, lmOk] = await Promise.all([ace.isOnline(), lm.isOnline()]);
  return { ace: aceStarting ? 'starting' : aceOk ? 'online' : 'offline', aceOwned: aceProc.owned, lm: lmOk ? 'online' : 'offline' };
}

function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: 'VEGA-Music-AI',
    backgroundColor: '#0c0b12',
    show: false,
    frame: mac,
    titleBarStyle: mac ? 'hiddenInset' : undefined,
    trafficLightPosition: mac ? { x: 18, y: 18 } : undefined,
    icon: join(__dirname, 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('focus', () => win?.flashFrame(false));
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

// ───────────── IPC ─────────────
ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => settings.set(patch));
ipcMain.handle('settings:reset', () => settings.reset());
ipcMain.handle('settings:pickFolder', async (_e, current: string) => {
  const r = await dialog.showOpenDialog(win!, { defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('status', () => status());
ipcMain.handle('ace:start', async () => { await ensureAce(undefined, undefined, true); });
ipcMain.handle('ace:stop', () => aceProc.stop());
ipcMain.handle('lm:models', () => lm.listModels());

ipcMain.handle('lyrics:generate', async (e, p: TrackParams) => {
  lyricsAbort?.abort();
  lyricsAbort = new AbortController();
  try {
    return await generateLyrics(lm, settings.get(), p, (c) => e.sender.send('lyrics:chunk', c), lyricsAbort.signal);
  } finally { lyricsAbort = null; }
});
ipcMain.handle('lyrics:cancel', () => { lyricsAbort?.abort(); });

ipcMain.handle('job:start', (_e, p: TrackParams, title: string, lyrics: string) => generator.start(p, title, lyrics));
ipcMain.handle('job:cancel', () => generator.cancel());
ipcMain.handle('job:reset', () => generator.reset());
ipcMain.handle('job:get', () => generator.state);

ipcMain.handle('library:list', () => library.list());
ipcMain.handle('library:readAudio', (_e, id: string, file: string) => readFileSync(library.filePath(id, file)));
ipcMain.handle('library:update', (_e, id: string, patch: Partial<Track>) => library.update(id, patch));
ipcMain.handle('library:remove', async (_e, id: string) => { await shell.trashItem(library.dir(id)); });
ipcMain.handle('library:reveal', (_e, id: string, file?: string) => shell.showItemInFolder(file ? library.filePath(id, file) : join(library.dir(id), 'track.json')));
ipcMain.handle('library:openRoot', async () => { await shell.openPath(settings.get().libraryPath); });

ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
ipcMain.on('win:close', () => win?.close());

// ───────────── Жизненный цикл ─────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.setAppUserModelId('app.vega.musicai');
  void app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (settings.get().aceStopOnExit) aceProc.stop(); });
