/**
 * Задания с песнями (V3):
 *  - импорт: вокал и минус, распознавание слов, темп/тональность, структура, исправление текста моделью;
 *  - переписывание текста на новую тему с бюджетом слогов по секциям;
 *  - «новые слова на эту музыку»: ACE-Step (repaint или lego) → новый вокал (+ свой голос) → родной минус;
 *  - анализ стиля через ACE-Step (описание, жанр, темп, тональность).
 */
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { AceClient } from './ace';
import type { Library } from './library';
import type { LmStudio } from './lmstudio';
import type { SongStore } from './songs';
import type { VoiceStore } from './voices';
import { applyVoice } from './voiceJobs';
import { runWorker, toolArgs, type WorkerConfig, type WorkerEvent } from './voiceWorker';
import { DEFAULT_PARAMS, KEYS } from '../src/shared/catalog';
import { sanitizeLyrics } from '../src/shared/lyrics';
import {
  applyCleanup, applyRestructure, assembleRewrite, detectLanguage, fitScore, mergeStubLines, partMessages, restructureMessages, buildLines, buildSections, checkRewrite, cleanupMessages, guessGender,
  parseRewrite, rewriteMessages, sectionsToLyrics, sectionsWithText, songTrackParams, uniqueParts, type RewriteCheck,
} from '../src/shared/song';
import type {
  JobState, LyricsChunk, RemakeSpec, RewriteSpec, Settings, Song, SongImportSpec, SongSection, SongWord, Track,
} from '../src/shared/types';

export interface SongDeps {
  store: SongStore;
  library: Library;
  voices: VoiceStore;
  lm: LmStudio;
  ace: AceClient;
  settings: () => Settings;
  worker: () => WorkerConfig;
  ensureAce: (status: (msg: string, starting: boolean) => void, signal?: AbortSignal) => Promise<void>;
  /** Освободить видеопамять для обработки звука (выгрузить модель текста, по настройке остановить ACE-Step). */
  prepareGpu: () => Promise<void>;
  unloadLlm: () => Promise<void>;
  gpuBusy: () => boolean;
  onUpdate: (s: JobState) => void;
}

/** Секция «в такт»: сумма слогов ±12% и строки близки к фразам оригинала (см. fitScore). */
const FIT_OK = 0.16;
const MAX_FIX_ATTEMPTS = 3;

const IDLE: JobState = { id: '', kind: 'song', phase: 'idle', title: '', progress: 0, step: 0, stageLabel: '', detail: '', elapsedSec: 0, etaSec: null };
const RUNNING = ['preparing', 'starting', 'generating', 'saving'];
const IMPORT_STEPS = ['Вокал', 'Текст', 'Структура', 'Готово'];
const REMAKE_STEPS = ['Подготовка', 'Музыка', 'Вокал', 'Сведение', 'Сохранение'];

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Отменено', 'AbortError')); }, { once: true });
});

function lmError(e: any): Error {
  const msg = String(e?.message ?? e);
  if (/context|n_ctx|too many tokens|exceeds/i.test(msg)) {
    return new Error(`Текст песни не поместился в контекст модели. В LM Studio увеличьте Context Length до 8192 или больше и попробуйте снова.\n\n${msg.slice(0, 300)}`);
  }
  return e instanceof Error ? e : new Error(msg);
}

/** Переписать текст песни на тему: модель пишет уникальные секции, приложение проверяет слоги и собирает песню. */
export async function rewriteSong(
  lm: LmStudio, s: Settings, song: Song, spec: RewriteSpec, onChunk: (c: LyricsChunk) => void, signal: AbortSignal,
): Promise<{ language: string; title: string; text: string; warnings: string[]; checks: { name: string; target: number; actual: number; level: string }[] }> {
  const parts = uniqueParts(song.sections, spec.text ?? song.lyrics);
  if (!parts.length) throw new Error('В песне нет распознанных секций с текстом');
  const language = spec.language || song.language;
  const messages: { role: string; content: string }[] = rewriteMessages(song, parts, spec.theme, spec.matureDark, language);
  const stream = (msgs: { role: string; content: string }[], prefix = '') => lm.streamChat(
    { model: s.lyricsModel, messages: msgs, temperature: s.lyricsTemperature, max_tokens: 5000 },
    (full, reasoning) => {
      const open = /<think>(?![\s\S]*<\/think>)/i.test(full);
      onChunk({ text: (prefix + full.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')).trimStart(), thinking: reasoning || open });
    },
    signal,
  ).catch((e) => { throw lmError(e); });

  const raw = await stream(messages);
  const parsed = parseRewrite(raw, parts);
  // каждая секция, которая промахнулась по слогам или пропущена, — отдельно, до трёх попыток;
  // модель видит число слогов в каждой своей строке; остаётся самый близкий к цели вариант
  for (const [k, v] of parsed.parts) parsed.parts.set(k, mergeStubLines(v));
  for (const part of parts) {
    let best = parsed.parts.get(part.key);
    for (let attempt = 0; attempt < MAX_FIX_ATTEMPTS && fitScore(best, part) > FIT_OK; attempt++) {
      const context = assembleRewrite(song.sections, parts, parsed, spec.text ?? song.lyrics).text;
      const partRaw = await stream(partMessages(song, part, spec.theme, spec.matureDark, language, context, best), `${context}\n\n`);
      const raw1 = parseRewrite(partRaw.match(/\[[^\]]+\]/) ? partRaw : `[${part.name}]\n${partRaw}`, [part]).parts.get(part.key);
      const got = raw1?.length ? mergeStubLines(raw1) : undefined;
      if (got?.length && fitScore(got, part) < fitScore(best, part)) { best = got; parsed.parts.set(part.key, got); }
    }
  }
  let checks: RewriteCheck[] = checkRewrite(parts, parsed);
  checks = checkRewrite(parts, parsed);
  const assembled = assembleRewrite(song.sections, parts, parsed, spec.text ?? song.lyrics);
  const clean = sanitizeLyrics(assembled.text, { allowBacking: false, lang: language });
  const warnings: string[] = [];
  if (assembled.missing.length) warnings.push(`Модель не написала: ${assembled.missing.join(', ')} — там остался исходный текст`);
  const off = checks.filter((c) => c.level === 'bad' && c.actual > 0);
  if (off.length) warnings.push(`Слоги не совпали в: ${off.map((c) => c.part.name).join(', ')} — слова могут не лечь в такт, поправьте вручную`);
  return {
    language: detectLanguage(clean.text, language),
    title: parsed.title || `${song.title} (новый текст)`,
    text: clean.text,
    warnings,
    checks: checks.map((c) => ({ name: c.part.name, target: c.part.target, actual: c.actual, level: c.level })),
  };
}

export class SongJobs {
  state: JobState = { ...IDLE };
  private abort: AbortController | null = null;
  private t0 = 0;

  constructor(private d: SongDeps) {}

  get busy() { return RUNNING.includes(this.state.phase); }

  private set(patch: Partial<JobState>) {
    this.state = { ...this.state, ...patch, progress: Math.max(this.state.progress, patch.progress ?? 0), elapsedSec: (Date.now() - this.t0) / 1000 };
    this.d.onUpdate(this.state);
  }

  private begin(kind: 'song' | 'remake', title: string, steps: string[], targetId: string) {
    if (this.busy) throw new Error('Уже выполняется задание с песней');
    if (this.d.gpuBusy()) throw new Error('Видеокарта занята другим заданием. Дождитесь окончания и попробуйте снова.');
    this.t0 = Date.now();
    this.abort = new AbortController();
    this.state = { ...IDLE, id: `${kind}_${Date.now()}`, kind, title, steps, targetId, phase: 'preparing', stageLabel: steps[0], detail: 'Подготовка…' };
    this.d.onUpdate(this.state);
    return this.abort.signal;
  }

  private fail(e: any) {
    if (e?.name === 'AbortError') this.set({ phase: 'cancelled', stageLabel: 'Отменено', detail: 'Задание остановлено', etaSec: null });
    else this.set({ phase: 'error', stageLabel: 'Ошибка', error: String(e?.message ?? e), etaSec: null });
  }

  cancel() { this.abort?.abort(); }
  reset() { if (!this.busy) { this.state = { ...IDLE }; this.d.onUpdate(this.state); } }

  // ───────────── импорт песни ─────────────

  importSong(spec: SongImportSpec): string {
    if (!existsSync(spec.path)) throw new Error(`Файл не найден: ${spec.path}`);
    const title = basename(spec.path, extname(spec.path)).replace(/[_]+/g, ' ').trim().slice(0, 60) || 'Песня';
    const signal = this.begin('song', title, IMPORT_STEPS, '');
    const id = this.d.store.allocate(title);
    const source = `source${extname(spec.path).toLowerCase() || '.wav'}`;
    copyFileSync(spec.path, this.d.store.file(id, source));
    this.d.store.write({
      id, title, createdAt: new Date().toISOString(), status: 'analyzing', sourceName: basename(spec.path), source,
      duration: 0, bpm: null, key: null, gender: null, language: spec.language ?? '', sections: [], lyrics: '', warnings: [],
    });
    this.state = { ...this.state, targetId: id };
    void this.runImport(id, spec, signal).catch((e) => {
      this.fail(e);
      try { this.d.store.update(id, { status: 'error', error: e?.name === 'AbortError' ? 'Отменено' : String(e?.message ?? e) }); } catch { /* удалена */ }
    });
    return id;
  }

  private async runImport(id: string, spec: SongImportSpec, signal: AbortSignal) {
    const s = this.d.settings();
    this.set({ detail: 'Освобождаем видеопамять…', progress: 0.01 });
    await this.d.prepareGpu().catch(() => {});
    const cfg = this.d.worker();
    const dir = this.d.store.dir(id);
    const song = this.d.store.get(id);
    const args = ['analyze', ...toolArgs(s, cfg.python), '--input', join(dir, song.source), '--out', dir,
      '--language', spec.language || 'auto', '--asr-backend', s.asrBackend, '--asr-model', s.asrModel];
    if (s.asrModelsPath) args.push('--asr-models', s.asrModelsPath);
    this.set({ phase: 'generating', step: 0, stageLabel: 'Выделение вокала', detail: 'Отделяем голос от музыки…', progress: 0.02 });
    const r = await runWorker(cfg, args, (e) => {
      if (e.event === 'stage') {
        const step = e.name === 'transcribe' ? 1 : 0;
        this.set({ step, stageLabel: e.name === 'transcribe' ? 'Распознавание слов' : e.name === 'music' ? 'Темп и тональность' : 'Выделение вокала', detail: String(e.text ?? '') });
      }
      if (e.event === 'progress') this.set({ progress: 0.02 + 0.74 * (e.value ?? 0), detail: String(e.text ?? this.state.detail) });
    }, signal);

    const words: SongWord[] = r.words ?? [];
    const bpm = typeof r.bpm === 'number' ? r.bpm : null;
    const lines = buildLines(words, bpm);
    let sections = buildSections(lines, r.duration, bpm);
    const warnings: string[] = [...(r.warnings ?? [])];
    const language = spec.language || (r.language && String(r.language).slice(0, 2)) || 'ru';
    const recognized = sectionsToLyrics(sections);
    this.set({ step: 2, stageLabel: 'Структура', detail: 'Находим куплеты и припевы…', progress: 0.78 });

    if (spec.cleanup && s.songLlmCleanup && lines.length && (await this.d.lm.isOnline())) {
      try {
        this.set({ detail: 'Исправляем распознанный текст моделью…' });
        const res = await this.fixWithModel(sections, words, language, r.duration, bpm, signal, (chars) => {
          this.set({ progress: Math.min(0.97, 0.8 + 0.17 * Math.min(1, chars / (recognized.length * 1.2 + 200))) });
        });
        sections = res.sections;
        if (!res.ok) warnings.push('Модель не смогла исправить текст — показан текст как распознан');
        if (s.unloadLyricsModel) await this.d.unloadLlm().catch(() => {});
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        warnings.push(`Исправление текста моделью не удалось: ${String(e?.message ?? e).split('\n')[0]}`);
      }
    } else if (spec.cleanup && s.songLlmCleanup && lines.length) {
      warnings.push('LM Studio не запущен — текст показан как распознан, без исправлений');
    }

    const key = typeof r.key === 'string' && KEYS.includes(r.key) ? r.key : null;
    this.d.store.update(id, {
      status: 'ready', duration: r.duration, bpm: bpm ? Math.round(bpm) : null, key,
      f0Median: r.f0Median ?? null, note: r.note || undefined, gender: guessGender(r.f0Median), language,
      vocals: r.vocals, instrumental: r.instrumental, sections, lyrics: sectionsToLyrics(sections), recognized, warnings, error: undefined,
    });
    const voc = sections.filter((x) => x.kind === 'vocal');
    this.set({
      phase: 'done', step: 3, stageLabel: 'Готово', progress: 1, etaSec: null,
      detail: lines.length ? `${lines.length} строк · ${voc.length} секций${bpm ? ` · ${Math.round(bpm)} BPM` : ''}${key ? ` · ${key}` : ''}` : 'Слова не распознаны — впишите текст вручную',
    });
  }

  /**
   * Исправление моделью: сначала модель заново делит текст на строки и секции (время — по словам Whisper),
   * если ответ слишком далёк от распознанного — исправляются только слова в прежних строках.
   */
  private async fixWithModel(sections: SongSection[], words: SongWord[], language: string, duration: number, bpm: number | null,
    signal: AbortSignal, onChars: (n: number) => void = () => {}): Promise<{ sections: SongSection[]; ok: boolean }> {
    const s = this.d.settings();
    const ask = (messages: { role: string; content: string }[]) => this.d.lm.streamChat(
      { model: s.lyricsModel, messages, temperature: 0.2, max_tokens: 6000 }, (full) => onChars(full.length), signal,
    ).catch((e) => { throw lmError(e); });
    if (words.length) {
      const restructured = applyRestructure(words, await ask(restructureMessages(sections, language)), duration, bpm);
      if (restructured && restructured.some((x) => x.kind === 'vocal')) return { sections: restructured, ok: true };
    }
    const res = applyCleanup(sections, await ask(cleanupMessages(sections, language)));
    return { sections: res.sections, ok: res.fixedBlocks > 0 };
  }

  /** Повторно исправить текст моделью (по текущим правкам). */
  async cleanup(id: string, signal: AbortSignal): Promise<Song> {
    const song = this.d.store.get(id);
    const sections = sectionsWithText(song.sections, song.lyrics);
    let words: SongWord[] = [];
    try { words = JSON.parse(readFileSync(this.d.store.file(id, 'words.json'), 'utf8')).words ?? []; } catch { /* старая песня */ }
    const res = await this.fixWithModel(sections, words, song.language, song.duration, song.bpm, signal);
    if (!res.ok) throw new Error('Модель вернула текст в неожиданном виде — попробуйте ещё раз');
    return this.d.store.update(id, { sections: res.sections, lyrics: sectionsToLyrics(res.sections) });
  }

  // ───────────── анализ стиля (ACE-Step) ─────────────

  async analyzeStyle(id: string, signal?: AbortSignal): Promise<Song> {
    const song = this.d.store.get(id);
    await this.d.ensureAce(() => {}, signal);
    const task = await this.d.ace.submit({ task_type: 'text2music', full_analysis_only: true, src_audio_path: join(this.d.store.dir(id), song.source), lm_backend: 'pt' });
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await sleep(1500, signal);
      const q = await this.d.ace.queryRaw(task).catch(() => null);
      if (!q || q.status === 0) continue;
      if (q.status === 2) throw new Error('ACE-Step не смог разобрать стиль песни (нужна версия ACE-Step 1.5 с анализом аудио)');
      const found = findAnalysis(q.data);
      if (!found.caption && !found.bpm) throw new Error('ACE-Step не вернул описание стиля — обновите ACE-Step 1.5');
      const patch: Partial<Song> = {};
      if (found.caption) patch.caption = found.caption;
      if (found.genres.length) patch.genres = found.genres;
      if (!song.bpm && found.bpm) patch.bpm = found.bpm;
      if (!song.key && found.key && KEYS.includes(found.key)) patch.key = found.key;
      return this.d.store.update(id, patch);
    }
    throw new Error('ACE-Step не ответил за 5 минут');
  }

  // ───────────── новые слова на эту музыку ─────────────

  remake(spec: RemakeSpec): string {
    const song = this.d.store.get(spec.songId);
    if (song.status !== 'ready') throw new Error('Песня ещё не разобрана');
    if (!song.instrumental || !song.vocals) throw new Error('У песни нет выделенного минуса — загрузите её заново');
    if (!spec.text.trim()) throw new Error('Нет текста — перепишите текст или впишите свой');
    if (spec.voiceId) {
      const v = this.d.voices.get(spec.voiceId);
      if (!this.d.voices.usable(v)) throw new Error(`Голос «${v.name}» ещё не готов`);
    }
    const title = spec.title.trim() || `${song.title} (новый текст)`;
    const signal = this.begin('remake', title, REMAKE_STEPS, spec.songId);
    void this.runRemake(song, { ...spec, title }, signal).catch((e) => this.fail(e));
    return this.state.id;
  }

  private async runRemake(song: Song, spec: RemakeSpec, signal: AbortSignal) {
    const s = this.d.settings();
    const dir = this.d.store.dir(song.id);
    this.set({ detail: 'Освобождаем видеопамять от модели текста…', progress: 0.01 });
    await this.d.unloadLlm().catch(() => {});
    this.set({ detail: 'Проверяем ACE-Step…', progress: 0.02 });
    await this.d.ensureAce((msg, starting) => this.set({ phase: starting ? 'starting' : 'preparing', detail: msg }), signal);

    // без описания стиля ACE-Step сочинит другой жанр — определяем его по самой песне
    if (!song.caption?.trim() && !song.genres?.length) {
      this.set({ detail: 'Определяем стиль песни (ACE-Step)…', progress: 0.03 });
      try { song = await this.analyzeStyle(song.id, signal); } catch (e: any) { if (e?.name === 'AbortError') throw e; }
    }

    const language = detectLanguage(spec.text, spec.language || song.language || 'ru');
    const lyrics = sanitizeLyrics(spec.text, { allowBacking: false, lang: language }).text;
    const gender = song.gender ?? 'male';
    const vocalTags = `${gender} vocal, single lead vocalist, clear articulate vocals`;
    const prompt = [song.caption?.trim(), song.genres?.length && !song.caption ? song.genres.join(', ') : '', vocalTags].filter(Boolean).join(', ');
    const base: Record<string, unknown> = {
      prompt, lyrics, audio_format: s.audioFormat, vocal_language: language, batch_size: spec.variants,
      audio_duration: song.duration, use_cot_caption: false, use_cot_language: false, lm_backend: 'pt',
      lm_model_path: s.aceLmModel, lm_temperature: s.aceLmTemperature, use_random_seed: true, time_signature: '4',
    };
    if (song.bpm) base.bpm = Math.round(song.bpm);
    if (song.key) base.key_scale = song.key;
    const lego = spec.method === 'lego';
    const strength = Math.min(1, Math.max(0.3, spec.coverStrength ?? 0.8));
    const req: Record<string, unknown> = lego
      ? { ...base, task_type: 'lego', track_name: 'vocals', src_audio_path: join(dir, song.instrumental!), model: s.aceBaseModel, inference_steps: 40, guidance_scale: 7, thinking: true }
      // cover: мелодия, аккорды, ритм и аранжировка — из оригинала, слова — новые
      : { ...base, task_type: 'cover', src_audio_path: join(dir, song.source), audio_cover_strength: strength, model: s.aceModel, inference_steps: s.aceInferenceSteps, thinking: false };

    let taskId: string;
    try {
      taskId = await this.d.ace.submit(req);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (lego && /model|not (found|loaded|available|initialized)|init/i.test(msg)) {
        this.set({ phase: 'starting', detail: `Загружаем base-модель ACE-Step (${s.aceBaseModel})… Первый раз — несколько минут` });
        await this.d.ace.init(s.aceBaseModel, s.aceLmModel).catch((ie) => {
          throw new Error(`Режим «вокал поверх минуса» требует base-модель ACE-Step (${s.aceBaseModel}). Скачайте её в ACE-Step или выберите «Ремейк с новыми словами».\n\n${String(ie?.message ?? ie).slice(0, 300)}`);
        });
        taskId = await this.d.ace.submit(req);
      } else if (/init/i.test(msg)) {
        this.set({ phase: 'starting', detail: 'Загружаем модели ACE-Step…' });
        await this.d.ace.init(s.aceModel, s.aceLmModel);
        taskId = await this.d.ace.submit(req);
      } else throw e;
    }

    const voice = spec.voiceId ? this.d.voices.get(spec.voiceId) : null;
    const workerJobs = lego ? 1 : (voice ? 1 : 0) + (spec.overlay ? 1 : 0);
    const expected = (lego ? 2.2 : 1) * s.calibration[String(spec.variants) as '1' | '2'] * song.duration + s.calibration.overhead;
    const genShare = workerJobs ? 0.5 : 0.9;
    const genStart = Date.now();
    let gen = 0;
    this.set({ phase: 'generating', step: 1, stageLabel: 'Музыка', detail: lego ? 'ACE-Step поёт новый текст поверх минуса' : 'ACE-Step перепевает песню с новыми словами', progress: 0.05 });
    let files: { file: string; seed?: string }[] = [];
    for (;;) {
      await sleep(1000, signal);
      const q = await this.d.ace.query(taskId).catch(() => null);
      const el = (Date.now() - genStart) / 1000;
      if (q?.status === 2) throw new Error(`ACE-Step: ${q.error}`);
      if (q?.status === 1) { files = q.files; break; }
      const real = q?.progress ?? 0;
      const timeFrac = Math.min(0.97, el / expected);
      gen = Math.max(gen, real, real > 0 ? Math.min(timeFrac, real + 0.25) : timeFrac);
      const eta = Math.max(0, expected - el) + spec.variants * workerJobs * (40 + song.duration * 0.4);
      this.set({ progress: 0.05 + genShare * gen, etaSec: eta > 2 ? Math.round(eta) : null });
    }
    if (!files.length) throw new Error('ACE-Step не вернул аудио');

    const trackId = this.d.library.allocate(spec.title);
    const ace: Track['variants'] = [];
    for (let i = 0; i < files.length; i++) {
      const ext = (files[i].file.match(/\.(mp3|wav|flac|ogg)(?:$|[?&])/i)?.[1] ?? s.audioFormat).toLowerCase();
      const name = `variant-${i + 1}-ace.${ext}`;
      await this.d.ace.download(files[i].file, this.d.library.filePath(trackId, name));
      ace.push({ file: name, seed: files[i].seed, label: `Вариант ${i + 1} · ACE`, original: true });
    }

    const params = {
      ...songTrackParams(song, DEFAULT_PARAMS), language, genres: song.genres?.length ? song.genres : ['Из песни'],
      theme: song.rewrite?.theme ?? '', voiceId: spec.voiceId, voiceShift: spec.voiceShift, variants: spec.variants,
    };
    const track: Track = {
      id: trackId, title: spec.title, createdAt: new Date().toISOString(), params, lyrics, caption: prompt,
      bpm: song.bpm ?? 0, variants: ace, generationSeconds: 0, voiceName: voice?.name,
    };
    const finish = (variants: Track['variants'], detail: string) => {
      this.set({ phase: 'saving', step: 4, stageLabel: 'Сохранение', detail: 'Сохраняем трек в библиотеку…', progress: 0.98 });
      const used = new Set(variants.map((v) => v.file));
      for (const a of ace) if (!used.has(a.file)) rmSync(this.d.library.filePath(trackId, a.file), { force: true });
      // ремейк ACE без своего голоса — основной вариант: variant-N вместо variant-N-ace
      variants = variants.map((v) => {
        if (v.original || !v.file.includes('-ace.') || variants.some((x) => x !== v && x.file === v.file)) return v;
        const file = v.file.replace('-ace.', '.');
        renameSync(this.d.library.filePath(trackId, v.file), this.d.library.filePath(trackId, file));
        return { ...v, file };
      });
      track.variants = variants;
      track.generationSeconds = Math.round((Date.now() - this.t0) / 1000);
      this.d.library.write(track);
      this.set({ phase: 'done', step: 4, stageLabel: 'Готово', progress: 1, etaSec: null, trackId, detail });
    };

    // cover без своего голоса и без родного минуса — результат ACE-Step и есть трек
    if (!workerJobs) {
      const main = ace.map((a, i) => {
        const file = a.file.replace('-ace.', '.');
        renameSync(this.d.library.filePath(trackId, a.file), this.d.library.filePath(trackId, file));
        return { file, seed: a.seed, label: `Вариант ${i + 1}` };
      });
      finish(main, 'Песня перепета с новыми словами');
      return;
    }

    this.set({ step: 2, stageLabel: 'Вокал', detail: 'Освобождаем видеопамять…', progress: 0.57 });
    await this.d.prepareGpu().catch(() => {});
    const cfg = this.d.worker();
    const vdir = voice ? this.d.voices.dir(voice.id) : '';
    const total = ace.length * workerJobs;
    let done = 0;
    const onWorker = (label: string) => (e: WorkerEvent) => {
      if (e.event === 'stage') {
        const step = e.name === 'mix' ? 3 : 2;
        this.set({ step, stageLabel: step === 3 ? 'Сведение' : 'Вокал', detail: `${e.text ?? ''}${label}` });
      }
      if (e.event === 'progress') this.set({ progress: 0.58 + 0.38 * ((done + (e.value ?? 0)) / total) });
    };
    const overlay = async (i: number, out: string, label: string) => {
      const work = join(tmpdir(), 'vega-song', `overlay_${Date.now()}_${i}`);
      const args = ['overlay', ...toolArgs(s, cfg.python), '--input', this.d.library.filePath(trackId, ace[i].file),
        '--instrumental', join(dir, song.instrumental!), '--orig-vocals', join(dir, song.vocals!),
        '--out', this.d.library.filePath(trackId, out), '--work', work, '--format', s.audioFormat];
      if (voice) {
        args.push('--reference', join(vdir, voice.reference!), '--steps', String(s.voiceDiffusionSteps), '--semitones', spec.voiceShift == null ? 'auto' : String(spec.voiceShift));
        if (voice.f0Median) args.push('--target-f0', String(voice.f0Median));
        if (voice.checkpoint && voice.config) args.push('--checkpoint', join(vdir, voice.checkpoint), '--config', join(vdir, voice.config));
      }
      try { return basename((await runWorker(cfg, args, onWorker(label), signal)).output); } finally { rmSync(work, { recursive: true, force: true }); }
    };

    const main: Track['variants'] = [];
    const minus: Track['variants'] = [];
    try {
      for (let i = 0; i < ace.length; i++) {
        const n = ace.length > 1 ? ` · вариант ${i + 1} из ${ace.length}` : '';
        if (lego) {
          main.push({ file: await overlay(i, `variant-${i + 1}.${s.audioFormat}`, n), seed: ace[i].seed, label: `Вариант ${i + 1}` });
          done++;
          continue;
        }
        if (voice) {
          const r = await applyVoice(cfg, s, this.d.voices, voice.id, this.d.library.filePath(trackId, ace[i].file),
            this.d.library.filePath(trackId, `variant-${i + 1}.${s.audioFormat}`), spec.voiceShift, onWorker(n), signal);
          main.push({ file: basename(r.output), seed: ace[i].seed, label: `Вариант ${i + 1}` });
          done++;
        } else main.push({ ...ace[i], label: `Вариант ${i + 1}`, original: undefined });
        if (spec.overlay) {
          minus.push({ file: await overlay(i, `variant-${i + 1}-minus.${s.audioFormat}`, n), seed: ace[i].seed, label: `Вариант ${i + 1} · родной минус` });
          done++;
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      // ACE-Step уже отработал — не теряем результат
      track.variants = [...main, ...minus, ...ace.filter((a) => !main.some((m) => m.file === a.file))];
      track.generationSeconds = Math.round((Date.now() - this.t0) / 1000);
      this.d.library.write(track);
      this.set({ phase: 'error', stageLabel: 'Ошибка обработки', trackId, etaSec: null,
        error: `Не удалось обработать вокал. Результат ACE-Step сохранён в библиотеке.\n\n${e?.message ?? e}` });
      return;
    }
    const keep = spec.keepAce && (lego || !!voice) ? ace : [];
    finish([...main, ...minus, ...keep], lego ? 'Новый вокал сведён с исходной музыкой' : 'Песня перепета с новыми словами');
  }

}

/** Ищет в ответе анализа ACE-Step описание, жанр, темп и тональность (формат зависит от версии). */
export function findAnalysis(data: any): { caption: string; genres: string[]; bpm: number | null; key: string | null } {
  const seen = new Set<any>();
  const acc = { caption: '', genres: [] as string[], bpm: null as number | null, key: null as string | null };
  const visit = (x: any, depth = 0) => {
    if (!x || typeof x !== 'object' || seen.has(x) || depth > 5) return;
    seen.add(x);
    if (Array.isArray(x)) { x.forEach((v) => visit(v, depth + 1)); return; }
    const cap = x.caption ?? x.prompt;
    if (!acc.caption && typeof cap === 'string' && cap.trim().length > 8) acc.caption = cap.trim();
    const g = x.genres ?? x.genre;
    if (!acc.genres.length && typeof g === 'string' && g && g !== 'N/A') acc.genres = g.split(/\s*,\s*/).filter(Boolean).slice(0, 4);
    const bpm = Number(x.bpm);
    if (!acc.bpm && Number.isFinite(bpm) && bpm > 30 && bpm < 300) acc.bpm = Math.round(bpm);
    const k = x.keyscale ?? x.key_scale;
    if (!acc.key && typeof k === 'string' && /^[A-G][#b]?\s+(major|minor)$/i.test(k.trim())) {
      const [n, m] = k.trim().split(/\s+/);
      acc.key = `${n[0].toUpperCase()}${n.slice(1)} ${m.toLowerCase()}`;
    }
    for (const v of Object.values(x)) visit(v, depth + 1);
  };
  visit(data);
  return acc;
}
