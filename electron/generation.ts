/** Оркестрация: генерация текста (LM Studio) и трека (ACE-Step) с прогрессом. */
import type { AceClient } from './ace';
import type { Library } from './library';
import type { LmStudio } from './lmstudio';
import { buildAceRequest, buildCaption, lyricsForAce } from '../src/shared/caption';
import { assembleLyrics, parseLlmLyrics, planStructure, sanitizeLyrics, stripThink, timing } from '../src/shared/lyrics';
import { buildLyricsMessages } from '../src/shared/prompts';
import type { JobState, LyricsChunk, LyricsResult, Settings, Track, TrackParams } from '../src/shared/types';

// ───────────────────────── Текст ─────────────────────────

export async function generateLyrics(
  lm: LmStudio,
  s: Settings,
  p: TrackParams,
  onChunk: (c: LyricsChunk) => void,
  signal: AbortSignal,
): Promise<LyricsResult> {
  const plan = planStructure(p);
  const messages = buildLyricsMessages(p, plan);
  const warnings: string[] = [];
  let title = '';
  let text = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await lm.streamChat(
      { model: s.lyricsModel, messages, temperature: s.lyricsTemperature },
      (full, reasoning) => {
        const open = /<think>(?![\s\S]*<\/think>)/i.test(full);
        onChunk({ text: stripThink(full).trimStart(), thinking: reasoning || open });
      },
      signal,
    );
    const parsed = parseLlmLyrics(raw);
    const assembled = assembleLyrics(plan, parsed);
    title = parsed.title || title;
    text = assembled.text;
    if (!assembled.missing.length) break;
    if (attempt === 1) warnings.push(`Модель не написала секции: ${assembled.missing.join(', ')}. Допишите их вручную или перегенерируйте.`);
  }
  const clean = sanitizeLyrics(text, { allowBacking: p.allowBacking, lang: p.language });
  return { title: title || 'Без названия', text: clean.text, warnings };
}

// ───────────────────────── Трек ─────────────────────────

export interface GeneratorDeps {
  ace: AceClient;
  library: Library;
  settings: () => Settings;
  ensureAce: (status: (msg: string, starting: boolean) => void, signal: AbortSignal) => Promise<void>;
  unloadLlm: () => Promise<void>;
  saveCalibration: (variants: 1 | 2, secPerAudioSec: number) => void;
  onUpdate: (s: JobState) => void;
}

const IDLE: JobState = { id: '', phase: 'idle', title: '', progress: 0, step: 0, stageLabel: '', detail: '', elapsedSec: 0, etaSec: null };

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Отменено', 'AbortError')); }, { once: true });
});

export class Generator {
  state: JobState = { ...IDLE };
  private abort: AbortController | null = null;

  constructor(private d: GeneratorDeps) {}

  get busy() { return ['preparing', 'starting', 'generating', 'saving'].includes(this.state.phase); }

  private set(patch: Partial<JobState>) {
    this.state = { ...this.state, ...patch, progress: Math.max(this.state.progress, patch.progress ?? 0) };
    this.d.onUpdate(this.state);
  }

  start(p: TrackParams, title: string, lyrics: string): string {
    if (this.busy) throw new Error('Уже идёт генерация трека');
    const id = `job_${Date.now()}`;
    this.state = { ...IDLE, id, phase: 'preparing', title: title || 'Без названия', stageLabel: 'Подготовка', detail: 'Готовим запрос…' };
    this.d.onUpdate(this.state);
    this.abort = new AbortController();
    void this.run(p, title, lyrics, this.abort.signal).catch((e) => {
      if (e?.name === 'AbortError') this.set({ phase: 'cancelled', stageLabel: 'Отменено', detail: 'Генерация остановлена', etaSec: null });
      else this.set({ phase: 'error', stageLabel: 'Ошибка', error: String(e?.message ?? e), etaSec: null });
    });
    return id;
  }

  cancel() { this.abort?.abort(); }

  reset() { if (!this.busy) { this.state = { ...IDLE }; this.d.onUpdate(this.state); } }

  private async run(p: TrackParams, title: string, lyrics: string, signal: AbortSignal) {
    const s = this.d.settings();
    const t0 = Date.now();
    const elapsed = () => (Date.now() - t0) / 1000;

    if (s.unloadLyricsModel && !p.instrumental) {
      this.set({ detail: 'Освобождаем видеопамять от модели текста…', progress: 0.005 });
      await this.d.unloadLlm().catch(() => {});
    }
    this.set({ detail: 'Проверяем ACE-Step…', progress: 0.01, elapsedSec: elapsed() });
    await this.d.ensureAce((msg, starting) => this.set({ phase: starting ? 'starting' : 'preparing', detail: msg, elapsedSec: elapsed() }), signal);

    const req = buildAceRequest(p, lyrics, s);
    const taskId = await this.d.ace.submit(req).catch(async (e) => {
      if (/init/i.test(String(e?.message))) {
        this.set({ phase: 'starting', detail: 'Загружаем модели ACE-Step (первый запуск может занять пару минут)…' });
        await this.d.ace.init(s.aceModel, s.aceLmModel);
        return this.d.ace.submit(req);
      }
      throw e;
    });

    const variants = p.variants;
    const expected = s.calibration[String(variants) as '1' | '2'] * p.duration + s.calibration.overhead;
    const genStart = Date.now();
    let gen = 0;
    this.set({ phase: 'generating', step: 1, stageLabel: 'Композиция', detail: 'Сочиняем мелодию и аранжировку', progress: 0.04 });

    for (;;) {
      await sleep(1000, signal);
      const q = await this.d.ace.query(taskId).catch(() => null);
      const genElapsed = (Date.now() - genStart) / 1000;
      if (q?.status === 2) throw new Error(`ACE-Step: ${q.error}`);
      if (q?.status === 1) {
        await this.save(p, title, lyrics, q.files, taskId, elapsed());
        this.d.saveCalibration(variants, Math.max(0.1, (genElapsed - s.calibration.overhead) / p.duration));
        return;
      }
      const real = q?.progress ?? 0;
      const timeFrac = Math.min(0.97, genElapsed / expected);
      // время может «опережать» реальный прогресс не больше чем на 25%
      const lead = real > 0 ? Math.min(timeFrac, real + 0.25) : timeFrac;
      gen = Math.max(gen, real, Math.min(lead, 0.97));
      const stageHint = `${q?.stage ?? ''} ${q?.progressText ?? ''}`.toLowerCase();
      let step = gen < 0.42 ? 1 : 2;
      if (/diffus|dit|denois|step \d/.test(stageHint)) step = 2;
      const label = step === 1 ? 'Композиция' : gen > 0.9 ? 'Финальная обработка' : 'Синтез звука';
      const detail = step === 1 ? 'Сочиняем мелодию и аранжировку' : gen > 0.9 ? 'Декодируем и собираем аудио' : 'Синтезируем инструменты и вокал';
      let eta = expected - genElapsed;
      if (real > 0.15) eta = 0.5 * eta + 0.5 * (genElapsed * (1 - real) / real);
      this.set({
        step, stageLabel: label, detail, progress: 0.04 + 0.92 * gen, elapsedSec: elapsed(),
        etaSec: eta > 2 ? Math.round(eta) : null,
      });
    }
  }

  private async save(p: TrackParams, title: string, lyrics: string, files: { file: string; seed?: string }[], taskId: string, seconds: number) {
    if (!files.length) throw new Error('ACE-Step не вернул аудио');
    const s = this.d.settings();
    this.set({ phase: 'saving', step: 3, stageLabel: 'Сохранение', detail: 'Сохраняем трек в библиотеку…', progress: 0.97 });
    const id = this.d.library.allocate(title);
    const variants = [] as Track['variants'];
    for (let i = 0; i < files.length; i++) {
      const ext = (files[i].file.match(/\.(mp3|wav|flac|ogg)(?:$|[?&])/i)?.[1] ?? s.audioFormat).toLowerCase();
      const name = `variant-${i + 1}.${ext}`;
      await this.d.ace.download(files[i].file, this.d.library.filePath(id, name));
      variants.push({ file: name, seed: files[i].seed });
    }
    const track: Track = {
      id,
      title: title || 'Без названия',
      createdAt: new Date().toISOString(),
      params: p,
      lyrics: lyricsForAce(p, lyrics),
      caption: buildCaption(p),
      bpm: timing(p).bpm,
      variants,
      generationSeconds: Math.round(seconds),
    };
    this.d.library.write(track);
    void taskId;
    this.set({ phase: 'done', step: 3, stageLabel: 'Готово', detail: 'Трек сохранён в библиотеку', progress: 1, trackId: id, etaSec: null, elapsedSec: Math.round(seconds) });
  }
}
