/** Оркестрация: генерация текста (LM Studio) и трека (ACE-Step) с прогрессом. */
import { basename } from 'node:path';
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
  /** Путь к исходной песне для режима «по мотивам» (V3). */
  songSource?: (id: string) => string | null;
  /** Голосовые модели (V2). Без них трек поётся голосом ACE-Step. */
  voice?: {
    name: (id: string) => string | null; // null — голос не готов
    beforeApply: () => Promise<void>; // освобождение видеопамяти
    apply: (voiceId: string, input: string, out: string, shift: number | null,
      onProgress: (frac: number, text: string) => void, signal: AbortSignal) => Promise<string>;
  };
}

const STEPS = ['Подготовка', 'Композиция', 'Синтез', 'Сохранение'];
const STEPS_VOICE = ['Подготовка', 'Композиция', 'Синтез', 'Голос', 'Сохранение'];

const IDLE: JobState = { id: '', kind: 'track', phase: 'idle', title: '', progress: 0, step: 0, stageLabel: '', detail: '', elapsedSec: 0, etaSec: null };

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
    if (this.blocked?.()) throw new Error('Видеокарта занята заданием с голосом. Дождитесь окончания.');
    const withVoice = !!p.voiceId && !p.instrumental;
    if (withVoice && !this.d.voice?.name(p.voiceId!)) throw new Error('Выбранный голос ещё не готов — выберите другой или дождитесь окончания обучения');
    const id = `job_${Date.now()}`;
    this.state = { ...IDLE, id, steps: withVoice ? STEPS_VOICE : STEPS, phase: 'preparing', title: title || 'Без названия', stageLabel: 'Подготовка', detail: 'Готовим запрос…' };
    this.d.onUpdate(this.state);
    this.abort = new AbortController();
    void this.run(p, title, lyrics, this.abort.signal).catch((e) => {
      if (e?.name === 'AbortError') this.set({ phase: 'cancelled', stageLabel: 'Отменено', detail: 'Генерация остановлена', etaSec: null });
      else this.set({ phase: 'error', stageLabel: 'Ошибка', error: String(e?.message ?? e), etaSec: null });
    });
    return id;
  }

  cancel() { this.abort?.abort(); }

  /** Проверка внешней занятости видеокарты (задания с голосом). */
  blocked?: () => boolean;

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

    const src = p.cover && p.sourceSongId && !p.instrumental ? this.d.songSource?.(p.sourceSongId) ?? null : null;
    if (p.cover && p.sourceSongId && !p.instrumental && !src) throw new Error('Исходная песня для режима «по мотивам» не найдена — выключите его или загрузите песню заново');
    const req = buildAceRequest(p, lyrics, s, { srcAudioPath: src });
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
    const withVoice = !!p.voiceId && !p.instrumental && !!this.d.voice;
    const genShare = withVoice ? 0.62 : 0.92;
    const voiceExpected = withVoice ? variants * (40 + p.duration * 0.45) : 0;
    const genStart = Date.now();
    let gen = 0;
    this.set({ phase: 'generating', step: 1, stageLabel: 'Композиция', detail: 'Сочиняем мелодию и аранжировку', progress: 0.04 });

    for (;;) {
      await sleep(1000, signal);
      const q = await this.d.ace.query(taskId).catch(() => null);
      const genElapsed = (Date.now() - genStart) / 1000;
      if (q?.status === 2) throw new Error(`ACE-Step: ${q.error}`);
      if (q?.status === 1) {
        await this.save(p, title, lyrics, q.files, taskId, t0, signal);
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
      eta += voiceExpected;
      this.set({
        step, stageLabel: label, detail, progress: 0.04 + genShare * gen, elapsedSec: elapsed(),
        etaSec: eta > 2 ? Math.round(eta) : null,
      });
    }
  }

  private async save(p: TrackParams, title: string, lyrics: string, files: { file: string; seed?: string }[], taskId: string, t0: number, signal: AbortSignal) {
    if (!files.length) throw new Error('ACE-Step не вернул аудио');
    const s = this.d.settings();
    const withVoice = !!p.voiceId && !p.instrumental && !!this.d.voice;
    const last = withVoice ? 4 : 3;
    const seconds = () => Math.round((Date.now() - t0) / 1000);
    this.set({
      phase: withVoice ? 'generating' : 'saving', step: withVoice ? 3 : 3,
      stageLabel: withVoice ? 'Голос' : 'Сохранение', detail: 'Получаем аудио от ACE-Step…', progress: withVoice ? 0.66 : 0.97,
    });
    const id = this.d.library.allocate(title);
    const originals = [] as Track['variants'];
    for (let i = 0; i < files.length; i++) {
      const ext = (files[i].file.match(/\.(mp3|wav|flac|ogg)(?:$|[?&])/i)?.[1] ?? s.audioFormat).toLowerCase();
      const name = withVoice ? `variant-${i + 1}-ace.${ext}` : `variant-${i + 1}.${ext}`;
      await this.d.ace.download(files[i].file, this.d.library.filePath(id, name));
      originals.push({ file: name, seed: files[i].seed, ...(withVoice ? { label: `Вариант ${i + 1} · голос ACE-Step`, original: true } : {}) });
    }
    const track: Track = {
      id,
      title: title || 'Без названия',
      createdAt: new Date().toISOString(),
      params: p,
      lyrics: lyricsForAce(p, lyrics),
      caption: buildCaption(p),
      bpm: timing(p).bpm,
      variants: originals,
      generationSeconds: seconds(),
    };
    void taskId;

    if (withVoice) {
      const voiceName = this.d.voice!.name(p.voiceId!) ?? 'голос';
      track.voiceName = voiceName;
      const converted = [] as Track['variants'];
      try {
        this.set({ detail: 'Освобождаем видеопамять для голоса…' });
        await this.d.voice!.beforeApply();
        for (let i = 0; i < originals.length; i++) {
          const out = this.d.library.filePath(id, `variant-${i + 1}.${s.audioFormat}`);
          const file = await this.d.voice!.apply(p.voiceId!, this.d.library.filePath(id, originals[i].file), out, p.voiceShift, (f, text) => {
            const n = originals.length;
            this.set({ progress: 0.66 + 0.3 * ((i + f) / n), detail: `${text}${n > 1 ? ` · вариант ${i + 1} из ${n}` : ''}`, elapsedSec: seconds() });
          }, signal);
          converted.push({ file: basename(file), seed: originals[i].seed, label: `Вариант ${i + 1} · ${voiceName}` });
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        track.variants = originals;
        track.generationSeconds = seconds();
        this.d.library.write(track);
        this.set({ phase: 'error', stageLabel: 'Ошибка голоса', trackId: id, etaSec: null,
          error: `Перепеть голосом «${voiceName}» не удалось. Исходные варианты ACE-Step сохранены в библиотеке.\n\n${e?.message ?? e}` });
        return;
      }
      track.variants = [...converted, ...originals];
    }
    this.set({ phase: 'saving', step: last, stageLabel: 'Сохранение', detail: 'Сохраняем трек в библиотеку…', progress: 0.98 });
    track.generationSeconds = seconds();
    this.d.library.write(track);
    this.set({ phase: 'done', step: last, stageLabel: 'Готово', detail: 'Трек сохранён в библиотеку', progress: 1, trackId: id, etaSec: null, elapsedSec: seconds() });
  }
}
