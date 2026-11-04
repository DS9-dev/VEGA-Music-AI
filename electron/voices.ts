/** Хранилище голосовых моделей: одна папка на голос (voice.json, sources/, dataset/, model/, reference.wav). */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceModel } from '../src/shared/types';

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(hz: number): string {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return `${NOTES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/**
 * Средняя высота голоса с поправкой на пол: прежний оценщик на хриплом вокале ошибался на октаву вверх
 * (мужской голос «G4»). В пении мужской голос в среднем ниже ~260 Гц, женский — выше ~160 Гц.
 */
export function normalizeVoicePitch<T extends Pick<VoiceModel, 'gender' | 'f0Median' | 'note'>>(v: T): T {
  let f = v.f0Median;
  if (!f || !Number.isFinite(f)) return v;
  if (v.gender === 'male') while (f > 260) f /= 2;
  else while (f < 160) f *= 2;
  if (f === v.f0Median) return v;
  return { ...v, f0Median: Math.round(f * 10) / 10, note: noteName(f) };
}

export class VoiceStore {
  constructor(private root: () => string) {}

  dir(id: string) {
    if (!/^[^\\/:*?"<>|]+$/.test(id) || id.includes('..')) throw new Error('Некорректный id голоса');
    return join(this.root(), id);
  }

  list(): VoiceModel[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    const out: VoiceModel[] = [];
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = join(root, d.name, 'voice.json');
      if (!existsSync(f)) continue;
      try { out.push(normalizeVoicePitch({ ...JSON.parse(readFileSync(f, 'utf8')), id: d.name })); } catch { /* битый файл */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): VoiceModel {
    return normalizeVoicePitch({ ...JSON.parse(readFileSync(join(this.dir(id), 'voice.json'), 'utf8')), id });
  }

  allocate(name: string): string {
    const slug = (name || 'Голос').replace(/[\\/:*?"<>|.]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 40) || 'Голос';
    let id = slug;
    for (let i = 2; existsSync(join(this.root(), id)); i++) id = `${slug}-${i}`;
    mkdirSync(join(this.root(), id, 'sources'), { recursive: true });
    return id;
  }

  write(v: VoiceModel): VoiceModel {
    mkdirSync(this.dir(v.id), { recursive: true });
    const next = { ...v, updatedAt: new Date().toISOString() };
    writeFileSync(join(this.dir(v.id), 'voice.json'), JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  update(id: string, patch: Partial<VoiceModel>): VoiceModel {
    return this.write({ ...this.get(id), ...patch, id });
  }

  remove(id: string) { rmSync(this.dir(id), { recursive: true, force: true }); }

  /** Голос пригоден для пения: есть эталон, а для обученного — чекпойнт. */
  usable(v: VoiceModel): boolean {
    if (v.status !== 'ready' || !v.reference) return false;
    if (!existsSync(join(this.dir(v.id), v.reference))) return false;
    return !v.checkpoint || existsSync(join(this.dir(v.id), v.checkpoint));
  }
}
