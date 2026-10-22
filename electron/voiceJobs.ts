/** Задания с голосовыми моделями: создание и обучение голоса, дообучение, перепевка трека из библиотеки. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { Library } from './library';
import type { VoiceStore } from './voices';
import { runWorker, toolArgs, type WorkerConfig, type WorkerEvent } from './voiceWorker';
import {
  VOICE_PROFILE_STEPS,
  type JobState, type NewVoiceSpec, type Settings, type Track, type VoiceCheck, type VoiceModel, type VoiceTrainProfile,
} from '../src/shared/types';

export interface VoiceDeps {
  store: VoiceStore;
  library: Library;
  settings: () => Settings;
  worker: () => WorkerConfig;
  /** Освободить видеопамять: выгрузить модель текста, при необходимости остановить ACE-Step. */
  prepareGpu: () => Promise<void>;
  /** Занята ли видеокарта генерацией трека. */
  gpuBusy: () => boolean;
  onUpdate: (s: JobState) => void;
}

const IDLE: JobState = { id: '', kind: 'voice', phase: 'idle', title: '', progress: 0, step: 0, stageLabel: '', detail: '', elapsedSec: 0, etaSec: null };
const RUNNING = ['preparing', 'starting', 'generating', 'saving'];

/** Перепеть один аудиофайл голосом. Используется и генерацией трека, и «Перепеть» в библиотеке. */
export async function applyVoice(
  cfg: WorkerConfig,
  s: Settings,
  store: VoiceStore,
  voiceId: string,
  input: string,
  out: string,
  shift: number | null,
  onEvent: (e: WorkerEvent) => void,
  signal?: AbortSignal,
): Promise<{ output: string; semitones: number }> {
  const v = store.get(voiceId);
  if (!store.usable(v)) throw new Error(`Голос «${v.name}» ещё не готов`);
  const dir = store.dir(voiceId);
  const work = join(tmpdir(), 'vega-voice', `apply_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const args = ['apply', ...toolArgs(s, cfg.python),
    '--input', input, '--out', out, '--work', work,
    '--reference', join(dir, v.reference!),
    '--steps', String(s.voiceDiffusionSteps),
    '--semitones', shift == null ? 'auto' : String(shift),
    '--format', s.audioFormat];
  if (v.f0Median) args.push('--target-f0', String(v.f0Median));
  if (v.checkpoint && v.config) args.push('--checkpoint', join(dir, v.checkpoint), '--config', join(dir, v.config));
  try {
    return await runWorker(cfg, args, onEvent, signal);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export class VoiceJobs {
  state: JobState = { ...IDLE };
  private abort: AbortController | null = null;
  private t0 = 0;

  constructor(private d: VoiceDeps) {}

  get busy() { return RUNNING.includes(this.state.phase); }

  private set(patch: Partial<JobState>) {
    this.state = {
      ...this.state, ...patch,
      progress: Math.max(this.state.progress, patch.progress ?? 0),
      elapsedSec: (Date.now() - this.t0) / 1000,
    };
    this.d.onUpdate(this.state);
  }

  private begin(kind: JobState['kind'], title: string, steps: string[], targetId: string) {
    if (this.busy) throw new Error('Уже выполняется задание с голосом');
    if (this.d.gpuBusy()) throw new Error('Видеокарта занята созданием трека. Дождитесь окончания и попробуйте снова.');
    this.t0 = Date.now();
    this.abort = new AbortController();
    this.state = { ...IDLE, id: `voice_${Date.now()}`, kind, title, steps, targetId, phase: 'preparing', stageLabel: steps[0], detail: 'Подготовка…' };
    this.d.onUpdate(this.state);
    return this.abort.signal;
  }

  private fail(e: any, onFail?: (msg: string) => void) {
    if (e?.name === 'AbortError') {
      onFail?.('Отменено');
      this.set({ phase: 'cancelled', stageLabel: 'Отменено', detail: 'Задание остановлено', etaSec: null });
    } else {
      const msg = String(e?.message ?? e);
      onFail?.(msg);
      this.set({ phase: 'error', stageLabel: 'Ошибка', error: msg, etaSec: null });
    }
  }

  cancel() { this.abort?.abort(); }
  reset() { if (!this.busy) { this.state = { ...IDLE }; this.d.onUpdate(this.state); } }

  // ───────────── создание голоса ─────────────

  create(spec: NewVoiceSpec): string {
    if (!spec.consent) throw new Error('Подтвердите, что у вас есть право использовать этот голос');
    if (!spec.name.trim()) throw new Error('Укажите название голоса');
    if (!spec.sources.length) throw new Error('Добавьте хотя бы одну песню или запись голоса');
    for (const s of spec.sources) if (!existsSync(s.path)) throw new Error(`Файл не найден: ${s.path}`);
    const steps = spec.profile === 'zero' ? ['Вокал', 'Нарезка', 'Готово'] : ['Вокал', 'Нарезка', 'Обучение', 'Готово'];
    const signal = this.begin('voice', spec.name.trim(), steps, '');
    const id = this.d.store.allocate(spec.name.trim());
    const dir = this.d.store.dir(id);
    const sources = spec.sources.map((s, i) => {
      const file = `src-${i + 1}${extname(s.path).toLowerCase() || '.wav'}`;
      copyFileSync(s.path, join(dir, 'sources', file));
      return { file, name: basename(s.path), kind: s.kind };
    });
    const now = new Date().toISOString();
    this.d.store.write({ id, name: spec.name.trim(), gender: spec.gender, createdAt: now, updatedAt: now, status: 'preparing', profile: spec.profile, sources, consent: true });
    this.state = { ...this.state, targetId: id };
    void this.runCreate(id, spec.profile, signal).catch((e) => this.fail(e, (msg) => {
      try {
        const v = this.d.store.get(id);
        // если эталон уже есть — голос годится для пения без обучения
        if (v.reference && msg === 'Отменено' && v.status === 'training') this.d.store.update(id, { status: 'ready', profile: 'zero', checkpoint: undefined, config: undefined });
        else this.d.store.update(id, { status: 'error', error: msg });
      } catch { /* голос удалён */ }
    }));
    return id;
  }

  private async runCreate(id: string, profile: VoiceTrainProfile, signal: AbortSignal) {
    const train = profile !== 'zero';
    const prepShare = train ? 0.25 : 0.95;
    await this.prepareGpu();
    const v = this.d.store.get(id);
    const dir = this.d.store.dir(id);
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ sources: v.sources.map((s) => ({ path: join(dir, 'sources', s.file), kind: s.kind })) }), 'utf8');
    const cfg = this.d.worker();
    const s = this.d.settings();
    this.set({ phase: 'generating', step: 0, stageLabel: 'Выделение вокала', detail: 'Отделяем голос от музыки…' });
    const prep = await runWorker(cfg, ['prepare', ...toolArgs(s, cfg.python), '--manifest', manifest, '--out', dir], (e) => {
      if (e.event === 'stage') this.set({ step: e.name === 'separate' ? 0 : 1, stageLabel: e.name === 'separate' ? 'Выделение вокала' : 'Нарезка фраз', detail: String(e.text ?? '') });
      if (e.event === 'progress') this.set({ progress: 0.02 + prepShare * (e.value ?? 0), detail: String(e.text ?? this.state.detail) });
    }, signal);
    this.d.store.update(id, {
      dataset: { segments: prep.segments, seconds: prep.seconds, warnings: prep.warnings ?? [] },
      reference: prep.reference, f0Median: prep.f0Median ?? null, note: prep.note || undefined,
      status: train ? 'training' : 'ready',
    });
    if (train) await this.runTrain(id, profile, signal, 0.02 + prepShare);
    const fin = this.d.store.get(id);
    this.set({
      phase: 'done', step: this.state.steps!.length - 1, stageLabel: 'Готово', progress: 1, etaSec: null,
      detail: `${fin.dataset?.seconds ?? 0} с вокала · ${fin.dataset?.segments ?? 0} фраз${fin.training ? ` · ${fin.training.steps} шагов обучения` : ''}`,
    });
  }

  private async runTrain(id: string, profile: VoiceTrainProfile, signal: AbortSignal, from: number) {
    const steps = VOICE_PROFILE_STEPS[profile];
    const dir = this.d.store.dir(id);
    const cfg = this.d.worker();
    const s = this.d.settings();
    this.set({ step: 2, stageLabel: 'Обучение', detail: 'Загружаем Seed-VC…', progress: from });
    const res = await runWorker(cfg, ['train', ...toolArgs(s, cfg.python), '--dataset', join(dir, 'dataset'), '--out', dir, '--steps', String(steps)], (e) => {
      if (e.event !== 'progress') return;
      const loss = typeof e.loss === 'number' ? ` · ошибка ${e.loss.toFixed(3)}` : '';
      this.set({
        progress: from + (0.97 - from) * (e.value ?? 0),
        detail: `${e.text ?? ''}${loss}`,
        etaSec: typeof e.eta === 'number' ? e.eta : this.state.etaSec,
      });
    }, signal);
    this.d.store.update(id, {
      status: 'ready', profile, checkpoint: res.checkpoint, config: res.config, error: undefined,
      training: { steps: res.steps, seconds: res.seconds, finalLoss: res.finalLoss ?? null },
    });
  }

  /** Дообучить существующий голос (новый профиль шагов). */
  retrain(id: string, profile: VoiceTrainProfile) {
    if (profile === 'zero') throw new Error('Выберите профиль обучения');
    const v = this.d.store.get(id);
    if (!v.dataset || !existsSync(join(this.d.store.dir(id), 'dataset'))) throw new Error('У голоса нет подготовленных фраз — создайте его заново');
    const signal = this.begin('voice', v.name, ['Вокал', 'Нарезка', 'Обучение', 'Готово'], id);
    const prev = { status: v.status, profile: v.profile, checkpoint: v.checkpoint, config: v.config };
    this.d.store.update(id, { status: 'training', error: undefined });
    void (async () => {
      await this.prepareGpu();
      this.set({ phase: 'generating', step: 2, progress: 0.05 });
      await this.runTrain(id, profile, signal, 0.05);
      this.set({ phase: 'done', step: 3, stageLabel: 'Готово', progress: 1, etaSec: null, detail: `Обучено: ${VOICE_PROFILE_STEPS[profile]} шагов` });
    })().catch((e) => this.fail(e, () => { try { this.d.store.update(id, { ...prev, status: prev.status === 'training' ? 'ready' : prev.status }); } catch { /* */ } }));
  }

  // ───────────── перепевка трека ─────────────

  revoice(trackId: string, variantIndex: number, voiceId: string, shift: number | null): string {
    const track = this.d.library.read(trackId);
    const variant = track.variants[variantIndex];
    if (!variant) throw new Error('Вариант не найден');
    const voice = this.d.store.get(voiceId);
    if (!this.d.store.usable(voice)) throw new Error(`Голос «${voice.name}» ещё не готов`);
    const title = `${track.title} · ${voice.name}`;
    const signal = this.begin('revoice', title, ['Разделение', 'Голос', 'Сведение'], '');
    void (async () => {
      await this.prepareGpu();
      const s = this.d.settings();
      const newId = this.d.library.allocate(title);
      const src = this.d.library.filePath(trackId, variant.file);
      this.set({ phase: 'generating', step: 0, stageLabel: 'Разделение', detail: 'Отделяем вокал от музыки…', progress: 0.03 });
      const expected = 40 + track.params.duration * 0.45;
      const res = await applyVoice(this.d.worker(), s, this.d.store, voiceId, src, this.d.library.filePath(newId, `variant-1.${s.audioFormat}`), shift, (e) => {
        if (e.event === 'stage') {
          const step = e.name === 'separate' ? 0 : e.name === 'convert' ? 1 : 2;
          this.set({ step, stageLabel: ['Разделение', 'Голос', 'Сведение'][step], detail: String(e.text ?? '') });
        }
        if (e.event === 'progress') {
          const f = e.value ?? 0;
          this.set({ progress: 0.03 + 0.93 * f, etaSec: Math.max(3, Math.round(expected * (1 - f))) });
        }
      }, signal);
      const t: Track = {
        id: newId, title, createdAt: new Date().toISOString(),
        params: { ...track.params, voiceId, voiceShift: shift, voice: voice.gender },
        lyrics: track.lyrics, caption: track.caption, bpm: track.bpm,
        variants: [{ file: basename(res.output), label: voice.name }],
        generationSeconds: Math.round((Date.now() - this.t0) / 1000),
        voiceName: voice.name,
      };
      this.d.library.write(t);
      this.set({ phase: 'done', step: 2, stageLabel: 'Готово', progress: 1, etaSec: null, trackId: newId, detail: res.semitones ? `Сдвиг тона: ${res.semitones > 0 ? '+' : ''}${res.semitones} полутонов` : 'Трек сохранён в библиотеку' });
    })().catch((e) => this.fail(e));
    return this.state.id;
  }

  private async prepareGpu() {
    this.set({ detail: 'Освобождаем видеопамять…' });
    await this.d.prepareGpu().catch(() => {});
  }

  // ───────────── импорт / экспорт / проверка ─────────────

  async exportVoice(id: string, dest: string): Promise<string> {
    const r = await runWorker(this.d.worker(), ['export', '--voice-dir', this.d.store.dir(id), '--out', dest]);
    return r.file;
  }

  async importVoice(file: string): Promise<VoiceModel> {
    const tmp = join(this.d.settings().voicesPath, `.import_${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      await runWorker(this.d.worker(), ['import', '--file', file, '--out-dir', tmp]);
      const meta = JSON.parse(readFileSync(join(tmp, 'voice.json'), 'utf8')) as VoiceModel;
      const id = this.d.store.allocate(meta.name || basename(file, extname(file)));
      const dir = this.d.store.dir(id);
      rmSync(dir, { recursive: true, force: true });
      renameSync(tmp, dir);
      rmSync(join(dir, 'vegavoice.json'), { force: true });
      return this.d.store.write({ ...meta, id, status: 'ready', sources: [], error: undefined });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async check(): Promise<VoiceCheck> {
    const cfg = this.d.worker();
    return runWorker(cfg, ['check', ...toolArgs(this.d.settings(), cfg.python)]);
  }
}
