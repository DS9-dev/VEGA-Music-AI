import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AceClient, AceProcess } from './ace';
import { Generator, generateLyrics } from './generation';
import { Library } from './library';
import { LmStudio } from './lmstudio';
import { defaultSettings, SettingsStore } from './settings';
import { applyVoice, VoiceJobs } from './voiceJobs';
import { VoiceStore } from './voices';
import { SongStore } from './songs';
import { rewriteSong, SongJobs } from './songJobs';
import { seedvcPython, type WorkerConfig } from './voiceWorker';
import type {
  BackendStatus, JobState, NewVoiceSpec, RemakeSpec, RewriteSpec, Settings, Song, SongImportSpec, Track, TrackParams, VoiceModel, VoiceTrainProfile,
} from '../src/shared/types';

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
const voices = new VoiceStore(() => settings.get().voicesPath);
const songs = new SongStore(() => settings.get().songsPath);

/** Скрипт обработчика голоса: в собранном exe — из resources, иначе — из папки проекта. */
function workerConfig(): WorkerConfig {
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, 'voice', 'vega_voice.py') : join(app.getAppPath(), 'voice', 'vega_voice.py'),
    join(appRoot, 'voice', 'vega_voice.py'),
  ];
  return { python: seedvcPython(settings.get().seedvcPath), script: candidates.find((c) => existsSync(c)) ?? candidates[0] };
}

/** Перед работой с голосом: выгрузить модель текста и (по настройке) остановить ACE-Step, если его запускали мы. */
async function releaseVideoMemory(): Promise<void> {
  const s = settings.get();
  await lm.unload(s.lyricsModel).catch(() => false);
  if (s.freeAceForVoice && aceProc.owned) {
    aceProc.stop();
    await sleep(2500);
  }
}

let win: BrowserWindow | null = null;
let aceStarting: Promise<void> | null = null;
let lyricsAbort: AbortController | null = null;
let rewriteAbort: AbortController | null = null;

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
  onUpdate: (state) => broadcast(state),
  songSource: (id) => songs.sourcePath(id),
  voice: {
    name: (id) => { try { const v = voices.get(id); return voices.usable(v) ? v.name : null; } catch { return null; } },
    beforeApply: releaseVideoMemory,
    apply: async (voiceId, input, out, shift, onProgress, signal) => {
      const r = await applyVoice(workerConfig(), settings.get(), voices, voiceId, input, out, shift, (e) => {
        if (e.event === 'progress') onProgress(e.value ?? 0, String(e.text ?? ''));
      }, signal);
      return r.output;
    },
  },
});

const voiceJobs: VoiceJobs = new VoiceJobs({
  store: voices,
  library,
  settings: () => settings.get(),
  worker: workerConfig,
  prepareGpu: releaseVideoMemory,
  gpuBusy: () => generator.busy || songJobs.busy,
  onUpdate: (state) => broadcast(state),
});

const songJobs: SongJobs = new SongJobs({
  store: songs,
  library,
  voices,
  lm,
  ace,
  settings: () => settings.get(),
  worker: workerConfig,
  ensureAce,
  prepareGpu: releaseVideoMemory,
  unloadLlm: async () => { await lm.unload(settings.get().lyricsModel); },
  gpuBusy: () => generator.busy || voiceJobs.busy,
  onUpdate: (state) => broadcast(state),
});
generator.blocked = () => voiceJobs.busy || songJobs.busy;

let lastJob: JobState | null = null;
const RUNNING = ['preparing', 'starting', 'generating', 'saving'];

/** Общий поток состояния заданий (трек или голос) → окно, панель задач, уведомления. */
function broadcast(state: JobState) {
  lastJob = state;
  win?.webContents.send('job:update', state);
  if (!win) return;
  if (RUNNING.includes(state.phase)) win.setProgressBar(Math.max(0.02, state.progress));
  else win.setProgressBar(-1);
  if ((state.phase === 'done' || state.phase === 'error') && !win.isFocused()) {
    win.flashFrame(true);
    if (Notification.isSupported()) {
      const done = state.kind === 'voice' ? 'Голос готов' : state.kind === 'revoice' ? 'Трек перепет' : state.kind === 'song' ? 'Песня разобрана' : 'Трек готов';
      new Notification({ title: state.phase === 'done' ? done : 'Ошибка', body: state.phase === 'done' ? state.title : state.error ?? '' }).show();
    }
  }
}

function activeJob() {
  if (voiceJobs.busy) return voiceJobs;
  if (songJobs.busy) return songJobs;
  if (generator.busy) return generator;
  const k = lastJob?.kind;
  return k === 'song' || k === 'remake' ? songJobs : k && k !== 'track' ? voiceJobs : generator;
}

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
ipcMain.handle('job:cancel', () => activeJob().cancel());
ipcMain.handle('job:reset', () => { generator.reset(); voiceJobs.reset(); songJobs.reset(); lastJob = null; });
ipcMain.handle('job:get', () => activeJob().state);

// ───────────── Голоса (V2) ─────────────
const AUDIO_FILTER = { name: 'Аудио', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac'] };
const withUsable = (v: VoiceModel) => ({ ...v, usable: voices.usable(v) });
ipcMain.handle('voices:list', () => voices.list().map(withUsable));
ipcMain.handle('voices:pickSources', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Песни или записи голоса', properties: ['openFile', 'multiSelections'], filters: [AUDIO_FILTER] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('voices:create', (_e, spec: NewVoiceSpec) => voiceJobs.create(spec));
ipcMain.handle('voices:retrain', (_e, id: string, profile: VoiceTrainProfile) => voiceJobs.retrain(id, profile));
ipcMain.handle('voices:rename', (_e, id: string, name: string) => withUsable(voices.update(id, { name: name.trim() || voices.get(id).name })));
ipcMain.handle('voices:remove', async (_e, id: string) => { await shell.trashItem(voices.dir(id)); });
ipcMain.handle('voices:reveal', (_e, id: string) => shell.showItemInFolder(join(voices.dir(id), 'voice.json')));
ipcMain.handle('voices:readAudio', (_e, id: string) => readFileSync(join(voices.dir(id), voices.get(id).reference ?? 'reference.wav')));
ipcMain.handle('voices:export', async (_e, id: string) => {
  const v = voices.get(id);
  const r = await dialog.showSaveDialog(win!, { title: 'Сохранить голос', defaultPath: `${v.name}.vegavoice`, filters: [{ name: 'Голос VEGA-Music-AI', extensions: ['vegavoice'] }] });
  return r.canceled || !r.filePath ? null : voiceJobs.exportVoice(id, r.filePath);
});
ipcMain.handle('voices:import', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Открыть голос', properties: ['openFile'], filters: [{ name: 'Голос VEGA-Music-AI', extensions: ['vegavoice'] }] });
  return r.canceled ? null : withUsable(await voiceJobs.importVoice(r.filePaths[0]));
});
ipcMain.handle('voices:check', () => voiceJobs.check());
ipcMain.handle('voices:revoice', (_e, trackId: string, variant: number, voiceId: string, shift: number | null) => voiceJobs.revoice(trackId, variant, voiceId, shift));
ipcMain.handle('voices:openRoot', async () => { await shell.openPath(settings.get().voicesPath); });

// ───────────── Песни (V3) ─────────────
const songItem = (x: Song) => songs.item(x);
ipcMain.handle('songs:list', () => songs.list().map(songItem));
ipcMain.handle('songs:pick', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Песня', properties: ['openFile'], filters: [AUDIO_FILTER] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('songs:import', (_e, spec: SongImportSpec) => songJobs.importSong(spec));
ipcMain.handle('songs:update', (_e, id: string, patch: Partial<Song>) => {
  const allowed: Partial<Song> = {};
  if (typeof patch.title === 'string') allowed.title = patch.title.trim() || songs.get(id).title;
  if (typeof patch.lyrics === 'string') allowed.lyrics = patch.lyrics;
  if ('rewrite' in patch) allowed.rewrite = patch.rewrite ?? undefined;
  return songItem(songs.update(id, allowed));
});
ipcMain.handle('songs:remove', async (_e, id: string) => { await shell.trashItem(songs.dir(id)); });
ipcMain.handle('songs:reveal', (_e, id: string) => shell.showItemInFolder(join(songs.dir(id), 'song.json')));
ipcMain.handle('songs:readAudio', (_e, id: string, which: 'source' | 'vocals' | 'instrumental') => {
  const x = songs.get(id);
  const f = which === 'vocals' ? x.vocals : which === 'instrumental' ? x.instrumental : x.source;
  if (!f) throw new Error('Файл ещё не готов');
  return readFileSync(songs.file(id, f));
});
ipcMain.handle('songs:rewrite', async (e, id: string, spec: RewriteSpec) => {
  rewriteAbort?.abort();
  rewriteAbort = new AbortController();
  try {
    const song = songs.get(id);
    const r = await rewriteSong(lm, settings.get(), song, spec, (c) => e.sender.send('songs:chunk', c), rewriteAbort.signal);
    songs.update(id, { rewrite: { theme: spec.theme, title: r.title, text: r.text, matureDark: spec.matureDark, createdAt: new Date().toISOString() } });
    if (settings.get().unloadLyricsModel) void lm.unload(settings.get().lyricsModel).catch(() => false);
    return r;
  } finally { rewriteAbort = null; }
});
ipcMain.handle('songs:cancelRewrite', () => { rewriteAbort?.abort(); });
ipcMain.handle('songs:cleanup', async (_e, id: string) => {
  const c = new AbortController();
  return songItem(await songJobs.cleanup(id, c.signal));
});
ipcMain.handle('songs:analyzeStyle', async (_e, id: string) => {
  if (generator.busy || voiceJobs.busy || songJobs.busy) throw new Error('Видеокарта занята другим заданием — попробуйте позже');
  return songItem(await songJobs.analyzeStyle(id));
});
ipcMain.handle('songs:remake', (_e, spec: RemakeSpec) => songJobs.remake(spec));
ipcMain.handle('songs:openRoot', async () => { await shell.openPath(settings.get().songsPath); });

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
