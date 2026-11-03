/** Хранилище песен (V3): одна папка на песню — song.json, source.*, vocals.wav, instrumental.wav, words.json. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Song, SongItem } from '../src/shared/types';

export class SongStore {
  constructor(private root: () => string) {}

  dir(id: string) {
    if (!/^[^\\/:*?"<>|]+$/.test(id) || id.includes('..')) throw new Error('Некорректный id песни');
    return join(this.root(), id);
  }

  file(id: string, name: string) {
    if (!/^[\w.\- ]+$/.test(name)) throw new Error('Некорректное имя файла');
    return join(this.dir(id), name);
  }

  list(): Song[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    const out: Song[] = [];
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = join(root, d.name, 'song.json');
      if (!existsSync(f)) continue;
      try { out.push({ ...JSON.parse(readFileSync(f, 'utf8')), id: d.name }); } catch { /* битый файл */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Song {
    return { ...JSON.parse(readFileSync(join(this.dir(id), 'song.json'), 'utf8')), id };
  }

  allocate(title: string): string {
    const slug = (title || 'Песня').replace(/[\\/:*?"<>|.]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 40) || 'Песня';
    let id = slug;
    for (let i = 2; existsSync(join(this.root(), id)); i++) id = `${slug}-${i}`;
    mkdirSync(join(this.root(), id), { recursive: true });
    return id;
  }

  write(s: Song): Song {
    mkdirSync(this.dir(s.id), { recursive: true });
    writeFileSync(join(this.dir(s.id), 'song.json'), JSON.stringify(s, null, 2), 'utf8');
    return s;
  }

  update(id: string, patch: Partial<Song>): Song {
    return this.write({ ...this.get(id), ...patch, id });
  }

  remove(id: string) { rmSync(this.dir(id), { recursive: true, force: true }); }

  item(s: Song): SongItem {
    const p = (f?: string) => (f && existsSync(join(this.dir(s.id), f)) ? join(this.dir(s.id), f) : undefined);
    return { ...s, paths: { source: join(this.dir(s.id), s.source), vocals: p(s.vocals), instrumental: p(s.instrumental) } };
  }

  /** Путь к исходнику для режима «по мотивам». */
  sourcePath(id: string): string | null {
    try {
      const s = this.get(id);
      const f = join(this.dir(id), s.source);
      return existsSync(f) ? f : null;
    } catch { return null; }
  }
}
