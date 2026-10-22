/** Хранилище голосовых моделей: одна папка на голос (voice.json, sources/, dataset/, model/, reference.wav). */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceModel } from '../src/shared/types';

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
      try { out.push({ ...JSON.parse(readFileSync(f, 'utf8')), id: d.name }); } catch { /* битый файл */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): VoiceModel {
    return { ...JSON.parse(readFileSync(join(this.dir(id), 'voice.json'), 'utf8')), id };
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
