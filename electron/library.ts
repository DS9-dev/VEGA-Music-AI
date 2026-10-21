/** Библиотека треков: одна папка на трек, внутри track.json и аудиофайлы вариантов. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Track } from '../src/shared/types';

export class Library {
  constructor(private root: () => string) {}

  dir(id: string) {
    if (!/^[^\\/:*?"<>|]+$/.test(id) || id.includes('..')) throw new Error('Некорректный id трека');
    return join(this.root(), id);
  }

  list(): Track[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    const out: Track[] = [];
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const f = join(root, name.name, 'track.json');
      if (!existsSync(f)) continue;
      try { out.push({ ...JSON.parse(readFileSync(f, 'utf8')), id: name.name }); } catch { /* пропускаем битые */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  allocate(title: string, now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    const slug = (title || 'Трек').replace(/[\\/:*?"<>|.]+/g, ' ').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'Трек';
    let id = `${stamp}_${slug}`;
    for (let i = 2; existsSync(join(this.root(), id)); i++) id = `${stamp}_${slug}-${i}`;
    mkdirSync(join(this.root(), id), { recursive: true });
    return id;
  }

  write(track: Track) {
    mkdirSync(this.dir(track.id), { recursive: true });
    writeFileSync(join(this.dir(track.id), 'track.json'), JSON.stringify(track, null, 2), 'utf8');
  }

  read(id: string): Track {
    return { ...JSON.parse(readFileSync(join(this.dir(id), 'track.json'), 'utf8')), id };
  }

  update(id: string, patch: Partial<Track>): Track {
    const t = { ...this.read(id), ...patch, id };
    this.write(t);
    return t;
  }

  filePath(id: string, file: string) {
    if (!/^[\w.\- ]+$/.test(file)) throw new Error('Некорректное имя файла');
    return join(this.dir(id), file);
  }
}
