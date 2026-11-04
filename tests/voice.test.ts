/**
 * Голосовые модели (V2): настоящий voice/vega_voice.py + имитации Seed-VC, MelBand-RoFormer и ACE-Step.
 * Нужен Python с numpy и scipy. На Windows и без Python тест пропускается (setup_app.bat его не требует).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AceClient } from '../electron/ace';
import { Generator } from '../electron/generation';
import { Library } from '../electron/library';
import { defaultSettings } from '../electron/settings';
import { applyVoice, VoiceJobs } from '../electron/voiceJobs';
import { VoiceStore } from '../electron/voices';
import type { WorkerConfig } from '../electron/voiceWorker';
import { SongStore } from '../electron/songs';
import { findAnalysis, rewriteSong, SongJobs } from '../electron/songJobs';
import { buildAceRequest } from '../src/shared/caption';
import { buildLines, buildSections, sectionsToLyrics } from '../src/shared/song';
import { DEFAULT_PARAMS } from '../src/shared/catalog';
import type { JobState, Settings } from '../src/shared/types';

const PY = process.env.PYTHON || (process.platform === 'win32' ? '' : spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout?.trim() || '');
const hasPy = !!PY && process.platform !== 'win32' && spawnSync(PY, ['-c', 'import numpy, scipy'], { stdio: 'ignore' }).status === 0;
const SCRIPT = resolve(process.cwd(), 'voice', 'vega_voice.py');

/** WAV 44.1 кГц: фразы гармонического тона с паузами (как «вокал»). */
function songWav(seconds = 30, hz = 196): Buffer {
  const sr = 44100, n = sr * seconds;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr, phrase = t % 4.5;
    const on = phrase < 3.8 ? Math.min(1, phrase / 0.05, (3.8 - phrase) / 0.05) : 0;
    let v = 0;
    for (let k = 1; k <= 4; k++) v += Math.sin(2 * Math.PI * hz * k * t) / k;
    const s = Math.round(v * 0.25 * on * 32767);
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 46 + i * 4);
  }
  return buf;
}

const FAKE_SEP = `#!${PY}
import argparse, os, shutil
p = argparse.ArgumentParser(); p.add_argument("--input_folder"); p.add_argument("--store_dir")
a, _ = p.parse_known_args()
for f in os.listdir(a.input_folder):
    stem = os.path.splitext(f)[0]
    shutil.copy(os.path.join(a.input_folder, f), os.path.join(a.store_dir, stem + "_vocals.wav"))
    shutil.copy(os.path.join(a.input_folder, f), os.path.join(a.store_dir, stem + "_instrumental.wav"))
`;
const FAKE_INFER = `import argparse, os, shutil
p = argparse.ArgumentParser()
for k in ["--source","--target","--output","--diffusion-steps","--length-adjust","--inference-cfg-rate","--f0-condition","--auto-f0-adjust","--semi-tone-shift","--fp16","--checkpoint","--config"]:
    p.add_argument(k)
a = p.parse_args(); os.makedirs(a.output, exist_ok=True)
shutil.copy(a.source, os.path.join(a.output, "vc_out.wav"))
`;
const FAKE_TRAIN = `import argparse, os, re, time
p = argparse.ArgumentParser()
for k in ["--config","--pretrained-ckpt","--dataset-dir","--run-name","--batch-size","--max-steps","--max-epochs","--save-every","--num-workers","--gpu"]:
    p.add_argument(k)
a = p.parse_args()
log_dir = re.search(r'^log_dir: "(.*)"$', open(a.config, encoding="utf-8").read(), re.M).group(1)
run = os.path.join(log_dir, a.run_name); os.makedirs(run, exist_ok=True)
delay = float(os.environ.get("FAKE_STEP_DELAY", "0"))
for s in range(0, int(a.max_steps), 10):
    print(f"epoch 0, step {s}, loss: {1.0/(s+1):.4f}", flush=True); time.sleep(delay)
open(os.path.join(run, "ft_model.pth"), "wb").write(b"model")
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'vega-v2-'));
  const seed = join(root, 'Seed-VC');
  mkdirSync(join(seed, 'configs', 'presets'), { recursive: true });
  writeFileSync(join(seed, 'inference.py'), FAKE_INFER);
  writeFileSync(join(seed, 'train.py'), FAKE_TRAIN);
  writeFileSync(join(seed, 'configs', 'presets', 'config_dit_mel_seed_uvit_whisper_base_f0_44k.yml'), 'log_dir: "./runs"\n');
  const blobs = join(seed, 'checkpoints', 'models--Plachta--Seed-VC', 'blobs');
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, 'pretrained'), '');
  truncateSync(join(blobs, 'pretrained'), 600_000_000); // разреженный файл — места не занимает
  const sepBin = join(root, 'StemSeparator', '.venv', 'bin');
  mkdirSync(sepBin, { recursive: true });
  writeFileSync(join(sepBin, 'melband-roformer-infer'), FAKE_SEP);
  chmodSync(join(sepBin, 'melband-roformer-infer'), 0o755);
  mkdirSync(join(root, 'models'));
  const song = join(root, 'song.wav');
  writeFileSync(song, songWav());
  const s: Settings = {
    ...defaultSettings(root), seedvcPath: seed, separatorPath: join(root, 'StemSeparator'), melbandModelsPath: join(root, 'models'),
    transformersCachePath: '', voicesPath: join(root, 'Voices'), libraryPath: join(root, 'Library'), audioFormat: 'wav',
  };
  const store = new VoiceStore(() => s.voicesPath);
  const library = new Library(() => s.libraryPath);
  const worker = (): WorkerConfig => ({ python: PY, script: SCRIPT });
  return { root, s, store, library, worker, song };
}

async function waitJob(get: () => JobState, ms = 60_000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (['done', 'error', 'cancelled'].includes(get().phase)) return get();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
}

test('голос из песни: выделение вокала → нарезка → обучение → готов', { skip: !hasPy && 'нет Python с numpy/scipy' }, async () => {
  const { s, store, library, worker, song } = setup();
  const states: JobState[] = [];
  let gpuPrepared = 0;
  const jobs = new VoiceJobs({ store, library, settings: () => s, worker, prepareGpu: async () => { gpuPrepared++; }, gpuBusy: () => false, onUpdate: (x) => states.push(x) });
  assert.throws(() => jobs.create({ name: 'Я', gender: 'male', sources: [{ path: song, kind: 'song' }], profile: 'quick', consent: false }), /право/);
  const id = jobs.create({ name: 'Мой голос', gender: 'male', sources: [{ path: song, kind: 'song' }], profile: 'quick', consent: true });
  const fin = await waitJob(() => jobs.state);
  assert.equal(fin.phase, 'done', fin.error ?? '');
  assert.equal(gpuPrepared, 1);
  const v = store.get(id);
  assert.equal(v.status, 'ready');
  assert.equal(v.checkpoint, 'model/ft_model.pth');
  assert.ok(existsSync(join(store.dir(id), 'model', 'ft_model.pth')));
  assert.ok(v.dataset!.segments >= 5, `segments ${v.dataset!.segments}`);
  assert.ok(Math.abs(v.f0Median! - 196) < 10, `f0 ${v.f0Median}`);
  assert.equal(v.note, 'G3');
  assert.equal(v.training!.steps, 300);
  assert.ok(store.usable(v));
  // прогресс монотонный, этапы идут по порядку
  for (let i = 1; i < states.length; i++) assert.ok(states[i].progress >= states[i - 1].progress);
  assert.deepEqual([...new Set(states.map((x) => x.step))], [0, 1, 2, 3]);
  assert.ok(states.some((x) => /Шаг \d+ из 300/.test(x.detail)));
});

test('отмена обучения оставляет голос рабочим (без обучения)', { skip: !hasPy && 'нет Python' }, async () => {
  const { s, store, library, worker, song } = setup();
  process.env.FAKE_STEP_DELAY = '0.05';
  const jobs = new VoiceJobs({ store, library, settings: () => s, worker, prepareGpu: async () => {}, gpuBusy: () => false, onUpdate: () => {} });
  const id = jobs.create({ name: 'Отмена', gender: 'female', sources: [{ path: song, kind: 'clean' }], profile: 'max', consent: true });
  for (let i = 0; i < 400 && !/Шаг/.test(jobs.state.detail) && jobs.busy; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(jobs.busy, jobs.state.error ?? '');
  jobs.cancel();
  const fin = await waitJob(() => jobs.state);
  delete process.env.FAKE_STEP_DELAY;
  assert.equal(fin.phase, 'cancelled');
  const v = store.get(id);
  assert.equal(v.status, 'ready');
  assert.equal(v.profile, 'zero');
  assert.ok(store.usable(v));
});

test('перепевка трека из библиотеки и экспорт/импорт .vegavoice', { skip: !hasPy && 'нет Python' }, async () => {
  const { s, store, library, worker, song, root } = setup();
  const jobs = new VoiceJobs({ store, library, settings: () => s, worker, prepareGpu: async () => {}, gpuBusy: () => false, onUpdate: () => {} });
  const vid = jobs.create({ name: 'Голос', gender: 'male', sources: [{ path: song, kind: 'clean' }], profile: 'zero', consent: true });
  assert.equal((await waitJob(() => jobs.state)).phase, 'done');
  assert.equal(store.get(vid).checkpoint, undefined);
  jobs.reset();
  const tid = library.allocate('Песня');
  writeFileSync(library.filePath(tid, 'variant-1.wav'), readFileSync(song));
  library.write({ id: tid, title: 'Песня', createdAt: new Date().toISOString(), params: DEFAULT_PARAMS, lyrics: '', caption: '', bpm: 120, variants: [{ file: 'variant-1.wav' }], generationSeconds: 1 });
  jobs.revoice(tid, 0, vid, null);
  const fin = await waitJob(() => jobs.state);
  assert.equal(fin.phase, 'done', fin.error ?? '');
  const t = library.read(fin.trackId!);
  assert.equal(t.title, 'Песня · Голос');
  assert.equal(t.voiceName, 'Голос');
  assert.ok(existsSync(library.filePath(t.id, t.variants[0].file)));
  // экспорт/импорт
  const file = await jobs.exportVoice(vid, join(root, 'Голос.vegavoice'));
  const imported = await jobs.importVoice(file);
  assert.notEqual(imported.id, vid);
  assert.equal(imported.name, 'Голос');
  assert.ok(store.usable(imported));
});

test('создание трека с голосом: ACE → перепевка → 2 варианта + исходники ACE', { skip: !hasPy && 'нет Python' }, async () => {
  const { s, store, library, worker, song } = setup();
  const jobs = new VoiceJobs({ store, library, settings: () => s, worker, prepareGpu: async () => {}, gpuBusy: () => false, onUpdate: () => {} });
  const vid = jobs.create({ name: 'Солист', gender: 'male', sources: [{ path: song, kind: 'clean' }], profile: 'zero', consent: true });
  await waitJob(() => jobs.state);
  const wav = readFileSync(song);
  let polls = 0;
  const server = createServer(async (req, res) => {
    const send = (data: any) => res.end(JSON.stringify({ data, code: 200 }));
    if (req.url === '/release_task') { req.resume(); req.on('end', () => send({ task_id: 't' })); return; }
    if (req.url === '/query_result') {
      req.resume();
      req.on('end', () => send([polls++ < 1
        ? { status: 0, result: JSON.stringify([{ progress: 0.5 }]) }
        : { status: 1, result: JSON.stringify([{ file: '/v1/audio?path=a.wav' }, { file: '/v1/audio?path=b.wav' }]) }]));
      return;
    }
    if (req.url?.startsWith('/v1/audio')) { res.end(wav); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  s.aceEndpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  s.calibration = { '1': 0.01, '2': 0.01, overhead: 1 };
  let released = 0;
  const steps: number[] = [];
  const gen = new Generator({
    ace: new AceClient(() => s.aceEndpoint), library, settings: () => s, ensureAce: async () => {}, unloadLlm: async () => {},
    saveCalibration: () => {}, onUpdate: (x) => steps.push(x.step),
    voice: {
      name: (id) => { try { return store.usable(store.get(id)) ? store.get(id).name : null; } catch { return null; } },
      beforeApply: async () => { released++; },
      apply: async (id, input, out, shift, onP, sig) => (await applyVoice(worker(), s, store, id, input, out, shift, (e) => { if (e.event === 'progress') onP(e.value ?? 0, String(e.text ?? '')); }, sig)).output,
    },
  });
  gen.start({ ...DEFAULT_PARAMS, duration: 30, voiceId: vid }, 'С голосом', '[Verse 1]\nстрока песни');
  const fin = await waitJob(() => gen.state);
  server.close();
  assert.equal(fin.phase, 'done', fin.error ?? '');
  assert.deepEqual(fin.steps, ['Подготовка', 'Композиция', 'Синтез', 'Голос', 'Сохранение']);
  assert.equal(released, 1);
  assert.ok(steps.includes(3) && steps.includes(4));
  const t = library.read(fin.trackId!);
  assert.equal(t.voiceName, 'Солист');
  assert.deepEqual(t.variants.map((v) => v.label), ['Вариант 1', 'Вариант 2', 'Вариант 1 · ACE', 'Вариант 2 · ACE']);
  for (const v of t.variants) assert.ok(existsSync(library.filePath(t.id, v.file)), v.file);
  // выбранный, но не готовый голос — понятная ошибка до запуска
  assert.throws(() => gen.start({ ...DEFAULT_PARAMS, voiceId: 'нет-такого' }, 'x', 'y'), /не готов/);
});

// ───────────────────────── Песни (V3) ─────────────────────────

/** Имитация LM Studio: отдаёт заготовленные ответы по очереди. */
function fakeLm(answers: string[]) {
  const calls: { role: string; content: string }[][] = [];
  return {
    calls,
    isOnline: async () => true,
    unload: async () => true,
    streamChat: async (body: { messages: { role: string; content: string }[] }, onDelta: (full: string, r: boolean) => void) => {
      calls.push(body.messages);
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      onDelta(a, false);
      return a;
    },
  };
}

function songWords() {
  const line = (text: string, at: number) => text.split(' ').map((w, i) => ({ w, s: at + i * 0.35, e: at + i * 0.35 + 0.3 }));
  return [
    ...line('Ночь моя неоновая ночь', 0.5), ...line('Унеси печали прочь', 3.0),
    ...line('Город спит под тёплым дождём', 11.5), ...line('Фонари горят за окном', 14.0),
    ...line('Ночь моя неоновая ночь', 22.0), ...line('Унеси печали прочь', 24.5),
  ];
}

/** Разбор multipart/form-data имитацией ACE-Step: поля + имя и размер загруженного файла. */
function parseMultipart(body: string, type: string): Record<string, any> {
  const m = type.match(/boundary=(.+)$/);
  if (!m) return JSON.parse(Buffer.from(body, 'latin1').toString('utf8'));
  const out: Record<string, any> = {};
  for (const part of body.split(`--${m[1]}`)) {
    const head = part.indexOf('\r\n\r\n');
    if (head < 0) continue;
    const headers = part.slice(0, head);
    const value = part.slice(head + 4).replace(/\r\n$/, '');
    const name = headers.match(/name="([^"]+)"/)?.[1];
    const filename = headers.match(/filename="([^"]+)"/)?.[1];
    if (!name) continue;
    if (filename) { out.__file = filename; out.__fileBytes = value.length; out.__field = name; } else out[name] = Buffer.from(value, 'latin1').toString('utf8');
  }
  return out;
}

function songSetup() {
  const base = setup();
  const fake = join(base.root, 'words.json');
  writeFileSync(fake, JSON.stringify({ words: songWords(), language: 'ru' }));
  process.env.VEGA_ASR_FAKE = fake;
  base.s.songsPath = join(base.root, 'Songs');
  const songs = new SongStore(() => base.s.songsPath);
  return { ...base, songs };
}

test('импорт песни: вокал и минус → слова → секции с припевом → исправление моделью', { skip: !hasPy && 'нет Python' }, async () => {
  const { s, store, library, worker, song, songs } = songSetup();
  const lm = fakeLm(['#1 [Chorus]\nНочь моя неоновая ночь\nУнеси печали прочь\n#2 [Verse]\nГород спит под тёплым дождём\nФонари горят за окном\n#3 [Chorus]\nНочь моя неоновая ночь\nУнеси печали прочь']);
  let gpu = 0;
  const jobs = new SongJobs({
    store: songs, library, voices: store, lm: lm as any, ace: new AceClient(() => s.aceEndpoint), settings: () => s, worker,
    ensureAce: async () => {}, prepareGpu: async () => { gpu++; }, unloadLlm: async () => {}, gpuBusy: () => false, onUpdate: () => {},
  });
  const id = jobs.importSong({ path: song, language: null, cleanup: true });
  const fin = await waitJob(() => jobs.state);
  assert.equal(fin.phase, 'done', fin.error ?? '');
  assert.equal(gpu, 1);
  const x = songs.get(id);
  assert.equal(x.status, 'ready');
  assert.equal(x.language, 'ru');
  assert.equal(x.gender, 'male');
  assert.ok(x.duration > 29 && x.duration < 31);
  const voc = x.sections.filter((q) => q.kind === 'vocal');
  assert.deepEqual(voc.map((q) => q.tag), ['Chorus', 'Verse 1', 'Chorus']);
  assert.equal(voc[0].group, voc[2].group);
  assert.match(x.lyrics, /\[Chorus\]\nНочь моя неоновая ночь\nУнеси печали прочь/);
  assert.ok(x.recognized && x.vocals && x.instrumental);
  assert.ok(existsSync(join(songs.dir(id), 'vocals.wav')) && existsSync(join(songs.dir(id), 'instrumental.wav')));
  assert.equal(lm.calls.length, 1);
  assert.ok(songs.item(x).paths.vocals!.endsWith('vocals.wav'));
});

test('переписывание на тему: бюджет слогов и одна попытка исправить промахнувшиеся секции', async () => {
  const sections = buildSections(buildLines(songWords(), 120), 30, 120);
  const song = { id: 's', title: 'Неон', createdAt: '', status: 'ready' as const, sourceName: '', source: 'source.wav', duration: 30, bpm: 120, key: null,
    gender: 'male' as const, language: 'ru', sections, lyrics: sectionsToLyrics(sections), warnings: [] };
  const lm = fakeLm([
    'TITLE: Зимний вечер\n[Chorus]\nВечер мой холодный вечер\nСнег ложится мне на плечи\n[Verse 1]\nКороткая строка',
    '[Verse 1]\nТихо падает на крыши снег\nВремя замедляет бег',
  ]);
  const chunks: string[] = [];
  const r = await rewriteSong(lm as any, defaultSettings('/tmp/x'), song, { theme: 'зима', matureDark: false }, (c) => chunks.push(c.text), new AbortController().signal);
  assert.equal(lm.calls.length, 2, 'вторая попытка — только для промахнувшегося куплета');
  const fix = lm.calls[1].at(-1)!.content;
  assert.match(fix, /previous version of \[Verse 1\] has 6 syllables/);
  assert.match(fix, /"Короткая строка" — 6 syllables: too short, needs 8/);
  assert.match(fix, /Missing lines: write 2 lines/);
  assert.match(lm.calls[0][0].content, /The singer is a MAN/);
  assert.equal(r.title, 'Зимний вечер');
  assert.equal(r.text.match(/Вечер мой холодный вечер/g)!.length, 2);
  assert.match(r.text, /Тихо падает на крыши снег/);
  assert.ok(r.checks.every((c) => c.actual > 0));
  assert.ok(chunks.length >= 2);
});

test('переписывание: пропущенная секция дописывается отдельным запросом', async () => {
  const words = [
    ...'Ночь моя неоновая ночь'.split(' ').map((w, i) => ({ w, s: 1 + i * 0.4, e: 1.3 + i * 0.4 })),
    ...'Big Kenny talk to the people right now'.split(' ').map((w, i) => ({ w, s: 12 + i * 0.4, e: 12.3 + i * 0.4 })),
  ];
  const sections = buildSections(buildLines(words, 120), 30, 120).map((s) => (s.kind === 'vocal' && s.start > 10 ? { ...s, tag: 'Bridge' } : s));
  const song = { id: 's', title: 'T', createdAt: '', status: 'ready' as const, sourceName: '', source: 'source.wav', duration: 30, bpm: 120, key: null,
    gender: 'male' as const, language: 'en', sections, lyrics: sectionsToLyrics(sections), warnings: [] };
  const lm = fakeLm([
    'TITLE: Дом\n[Verse 1]\nВечер мой тихий опять настал',
    'Тихий вечер над рекой опять',
  ]);
  const r = await rewriteSong(lm as any, defaultSettings('/tmp/x'), song, { theme: 'дом', matureDark: false, language: 'ru' }, () => {}, new AbortController().signal);
  assert.match(lm.calls[1].at(-1)!.content, /Write ONLY the \[Bridge\] section now, in Russian/);
  assert.match(r.text, /Тихий вечер над рекой опять/);
  assert.ok(!r.warnings.some((w) => /не написала/.test(w)), r.warnings.join('; '));
});

test('новые слова на эту музыку: ремейк (cover) и lego → новый вокал → родной минус', { skip: !hasPy && 'нет Python' }, async () => {
  const { s, store, library, worker, song, songs, root } = songSetup();
  const voiceJobs = new VoiceJobs({ store, library, settings: () => s, worker, prepareGpu: async () => {}, gpuBusy: () => false, onUpdate: () => {} });
  const vid = voiceJobs.create({ name: 'Солист', gender: 'male', sources: [{ path: song, kind: 'clean' }], profile: 'zero', consent: true });
  await waitJob(() => voiceJobs.state);
  const wav = readFileSync(song);
  const bodies: any[] = [];
  let inits = 0;
  let polls = 0;
  const server = createServer((req, res) => {
    const send = (data: any, code = 200) => { res.statusCode = code; res.end(JSON.stringify(code === 200 ? { data, code: 200 } : { detail: data })); };
    const chunks: Buffer[] = [];
    req.on('data', (c) => { chunks.push(c); });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      if (req.url === '/release_task') {
        const b = parseMultipart(body, String(req.headers['content-type'] ?? ''));
        bodies.push(b);
        if (b.task_type === 'lego' && inits === 0) { send('Model acestep-v15-base not loaded', 400); return; }
        send({ task_id: `t${bodies.length}` });
        return;
      }
      if (req.url === '/v1/init') { inits++; send({ ok: true }); return; }
      if (req.url === '/query_result') {
        send([polls++ % 2 === 0 ? { status: 0, result: JSON.stringify([{ progress: 0.4 }]) } : { status: 1, result: JSON.stringify([{ file: '/v1/audio?path=a.wav' }]) }]);
        return;
      }
      if (req.url?.startsWith('/v1/audio')) { res.end(wav); return; }
      res.statusCode = 404; res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  s.aceEndpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  s.calibration = { '1': 0.01, '2': 0.01, overhead: 1 };
  const jobs = new SongJobs({
    store: songs, library, voices: store, lm: fakeLm(['']) as any, ace: new AceClient(() => s.aceEndpoint), settings: () => s, worker,
    ensureAce: async () => {}, prepareGpu: async () => {}, unloadLlm: async () => {}, gpuBusy: () => false, onUpdate: () => {},
  });
  after(() => server.close());
  const id = jobs.importSong({ path: song, language: 'ru', cleanup: false });
  await waitJob(() => jobs.state);
  const text = '[Chorus]\nСнег идёт и тает снег\n[Verse 1]\nНовый куплет\n[Chorus]\nСнег идёт и тает снег';

  jobs.remake({ songId: id, text, title: 'Снег', method: 'cover', voiceId: null, voiceShift: null, variants: 1, keepAce: true, coverStrength: 0.8, overlay: true });
  let fin = await waitJob(() => jobs.state);
  assert.equal(fin.phase, 'done', fin.error ?? '');
  const rp = bodies.at(-1);
  assert.equal(rp.task_type, 'cover');
  assert.equal(rp.audio_cover_strength, '0.8');
  assert.equal(rp.src_audio_path, undefined, 'абсолютный путь не отправляется — ACE-Step его запрещает');
  assert.equal(rp.__file, 'source.wav');
  assert.ok(rp.__fileBytes > 1_000_000, 'аудио загружено в запросе');
  assert.ok(bodies.some((b) => b.full_analysis_only === 'true'), 'без описания стиля — сначала анализ песни');
  assert.match(rp.prompt, /male vocal/);
  assert.match(rp.lyrics, /Снег идёт/);
  let t = library.read(fin.trackId!);
  assert.deepEqual(t.variants.map((v) => v.label), ['Вариант 1', 'Вариант 1 · родной минус'], 'без своего голоса ремейк ACE и есть вариант 1');
  assert.equal(t.variants[0].file, 'variant-1.wav');
  for (const v of t.variants) assert.ok(existsSync(library.filePath(t.id, v.file)), v.file);

  jobs.remake({ songId: id, text, title: 'Снег 2', method: 'lego', voiceId: vid, voiceShift: null, variants: 1, keepAce: false });
  fin = await waitJob(() => jobs.state);
  server.close();
  assert.equal(fin.phase, 'done', fin.error ?? '');
  assert.equal(inits, 1, 'base-модель загружена по требованию');
  const lg = bodies.at(-1);
  assert.equal(lg.task_type, 'lego');
  assert.equal(lg.track_name, 'vocals');
  assert.equal(lg.__file, 'instrumental.wav');
  assert.equal(lg.model, s.aceBaseModel);
  t = library.read(fin.trackId!);
  assert.equal(t.voiceName, 'Солист');
  assert.deepEqual(t.variants.map((v) => v.label), ['Вариант 1']);
  assert.ok(!existsSync(library.filePath(t.id, 'variant-1-ace.wav')), 'исходник ACE удалён, когда не нужен');
  void root;
});

test('«по мотивам»: запрос ACE-Step в режиме cover с исходной песней', () => {
  const s = defaultSettings('/tmp/x');
  const p = { ...DEFAULT_PARAMS, sourceSongId: 'a', cover: true, coverStrength: 0.7 };
  const req = buildAceRequest(p, '[Verse 1]\nстрока', s, { srcAudioPath: 'T:/Songs/a/source.mp3' });
  assert.equal(req.task_type, 'cover');
  assert.equal(req.src_audio_path, 'T:/Songs/a/source.mp3');
  assert.equal(req.audio_cover_strength, 0.7);
  const plain = buildAceRequest({ ...p, cover: false }, '[Verse 1]\nстрока', s, { srcAudioPath: 'x' });
  assert.equal(plain.task_type, undefined);
});

test('анализ стиля ACE-Step: поиск описания в ответе любой версии', () => {
  const r = findAnalysis({ status: 1, result: [{ metas: { bpm: 124, keyscale: 'f# minor', genres: 'synthwave, pop' }, prompt: 'dreamy synthwave with male vocals' }] });
  assert.equal(r.bpm, 124);
  assert.equal(r.key, 'F# minor');
  assert.deepEqual(r.genres, ['synthwave', 'pop']);
  assert.equal(r.caption, 'dreamy synthwave with male vocals');
});
