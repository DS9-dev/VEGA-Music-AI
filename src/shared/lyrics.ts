/**
 * Ядро работы с текстом песни:
 *  - расчёт структуры и количества строк от BPM и длительности;
 *  - сборка полного текста из уникальных секций (припев повторяется дословно);
 *  - очистка текста перед отправкой в ACE-Step;
 *  - анализ: слоги, предупреждения, оценка длительности пения.
 */
import { isRapLike, resolveBpm, soloTag } from './catalog';
import type { TrackParams } from './types';

// ───────────────────────── Тайминг ─────────────────────────

export interface Timing {
  bpm: number;
  barSec: number;
  lineSec: number;
  gapSec: number;
}

const DENSITY_FACTOR = { airy: 1.15, normal: 1, dense: 0.87 } as const;

export function timing(p: Pick<TrackParams, 'bpm' | 'genres' | 'density' | 'timbre'>): Timing {
  const bpm = resolveBpm(p);
  const barSec = 240 / bpm; // такт 4/4
  const rap = isRapLike(p.genres) || p.timbre === 'rap';
  // Обычная песня: строка ≈ 2 такта. Рэп: строка ≈ 1 такт.
  const base = rap ? Math.max(barSec, 2.2) : clamp(2 * barSec, 3.0, 6.0);
  const lineSec = base * DENSITY_FACTOR[p.density ?? 'normal'];
  return { bpm, barSec, lineSec, gapSec: barSec };
}

// ───────────────────────── Структура ─────────────────────────

export type UniqueKey = 'V1' | 'V2' | 'V3' | 'P' | 'C' | 'B';

export const UNIQUE_TAG: Record<UniqueKey, string> = {
  V1: 'Verse 1', V2: 'Verse 2', V3: 'Verse 3', P: 'Pre-Chorus', C: 'Chorus', B: 'Bridge',
};

export interface PlanSection {
  tag: string;
  kind: 'vocal' | 'instrumental';
  lines: number;
  bars: number;
  key?: UniqueKey;
}

export interface StructurePlan {
  timing: Timing;
  sections: PlanSection[];
  unique: { key: UniqueKey; tag: string; lines: number }[];
  vocalLines: number;
  estimatedSec: number;
  targetSec: number;
}

// Шаблоны вокальных частей: ключ:строк. Инструментальные части добавляются отдельно.
const TEMPLATES: string[][] = [
  ['C:4'],
  ['V1:2', 'C:4'],
  ['V1:4', 'C:4'],
  ['V1:4', 'C:4', 'V2:4', 'C:4'],
  ['V1:8', 'C:4', 'V2:8', 'C:4'],
  ['V1:8', 'C:8', 'V2:8', 'C:8'],
  ['V1:8', 'P:4', 'C:8', 'V2:8', 'P:4', 'C:8'],
  ['V1:8', 'C:8', 'V2:8', 'C:8', 'B:4', 'C:8'],
  ['V1:8', 'P:4', 'C:8', 'V2:8', 'P:4', 'C:8', 'B:4', 'C:8'],
  ['V1:8', 'P:4', 'C:8', 'V2:8', 'P:4', 'C:8', 'B:4', 'V3:8', 'C:8'],
  ['V1:8', 'P:4', 'C:8', 'V2:8', 'P:4', 'C:8', 'B:4', 'V3:8', 'P:4', 'C:8', 'C:8'],
  ['V1:12', 'P:4', 'C:8', 'V2:12', 'P:4', 'C:8', 'B:8', 'V3:12', 'P:4', 'C:8', 'C:8'],
  ['V1:16', 'C:8', 'V2:16', 'C:8', 'B:8', 'C:8'],
  ['V1:16', 'C:8', 'V2:16', 'C:8', 'B:8', 'V3:16', 'C:8', 'C:8'],
  ['V1:16', 'P:4', 'C:8', 'V2:16', 'P:4', 'C:8', 'B:8', 'V3:16', 'P:4', 'C:8', 'C:8'],
];

interface Inst { intro: number; outro: number; solo: number }

export function planStructure(p: TrackParams): StructurePlan {
  const t = timing(p);
  const target = p.duration;
  let best: { tpl: string[]; inst: Inst; est: number; score: number } | null = null;

  for (const tpl of TEMPLATES) {
    const items = tpl.map(parseItem);
    const vocalSec = items.reduce((s, it) => s + it.lines * t.lineSec + t.gapSec, 0);
    const withSolo = target >= 150 && items.length >= 4;
    const short = target < 60;
    // длины проигрышей задаём в секундах и переводим в такты (чётное число)
    const toBars = (sec: number) => Math.max(2, Math.round(sec / t.barSec / 2) * 2);
    const inst: Inst = { intro: short ? 0 : toBars(12), outro: toBars(short ? 6 : 14), solo: withSolo ? Math.max(4, toBars(15)) : 0 };
    const natural = inst.intro + inst.outro + inst.solo;
    const limits = {
      intro: [short ? 0 : 2, toBars(28)],
      outro: [2, toBars(36)],
      solo: withSolo ? [4, toBars(28)] : [0, 0],
    } as const;
    const instSec = () => (inst.intro + inst.outro + inst.solo) * t.barSec;
    // подгоняем инструментальные части под остаток времени
    for (let guard = 0; guard < 40; guard++) {
      const diff = target - vocalSec - instSec();
      if (Math.abs(diff) <= t.barSec * 2) break;
      const order: (keyof Inst)[] = diff > 0 ? ['outro', 'intro', 'solo'] : ['solo', 'intro', 'outro'];
      let moved = false;
      for (const k of order) {
        const [lo, hi] = limits[k];
        const next = inst[k] + (diff > 0 ? 2 : -2);
        if (next >= lo && next <= hi) { inst[k] = next; moved = true; break; }
      }
      if (!moved) break;
    }
    const est = vocalSec + instSec();
    const instDev = Math.abs(inst.intro + inst.outro + inst.solo - natural) * t.barSec;
    // штрафы: за «недобор» (пустой хвост) и за раздутые/урезанные проигрыши
    const score = Math.abs(est - target) + (est < target ? (target - est) * 0.3 : 0) + instDev;
    if (!best || score < best.score) best = { tpl, inst, est, score };
  }

  const { tpl, inst, est } = best!;
  const items = tpl.map(parseItem);
  const sections: PlanSection[] = [];
  if (inst.intro > 0) sections.push({ tag: 'Intro', kind: 'instrumental', lines: 0, bars: inst.intro });
  let chorusCount = 0;
  for (const it of items) {
    sections.push({ tag: UNIQUE_TAG[it.key], kind: 'vocal', lines: it.lines, bars: 0, key: it.key });
    if (it.key === 'C') {
      chorusCount++;
      if (chorusCount === 2 && inst.solo > 0) {
        sections.push({ tag: soloTag(p.genres), kind: 'instrumental', lines: 0, bars: inst.solo });
      }
    }
  }
  sections.push({ tag: 'Outro', kind: 'instrumental', lines: 0, bars: inst.outro });

  const uniqueMap = new Map<UniqueKey, number>();
  for (const it of items) uniqueMap.set(it.key, Math.max(uniqueMap.get(it.key) ?? 0, it.lines));
  const order: UniqueKey[] = ['V1', 'P', 'C', 'V2', 'B', 'V3'];
  const unique = order.filter((k) => uniqueMap.has(k)).map((k) => ({ key: k, tag: UNIQUE_TAG[k], lines: uniqueMap.get(k)! }));

  return {
    timing: t,
    sections,
    unique,
    vocalLines: items.reduce((s, it) => s + it.lines, 0),
    estimatedSec: est,
    targetSec: target,
  };
}

function parseItem(s: string): { key: UniqueKey; lines: number } {
  const [key, n] = s.split(':');
  return { key: key as UniqueKey, lines: Number(n) };
}

// ───────────────────────── Теги ─────────────────────────

const SECTION_ALIASES: Record<string, string> = {
  'intro': 'Intro', 'вступление': 'Intro', 'интро': 'Intro', 'начало': 'Intro',
  'verse': 'Verse', 'куплет': 'Verse', 'стих': 'Verse',
  'pre-chorus': 'Pre-Chorus', 'prechorus': 'Pre-Chorus', 'pre chorus': 'Pre-Chorus', 'предприпев': 'Pre-Chorus',
  'пред-припев': 'Pre-Chorus', 'распевка': 'Pre-Chorus', 'бридж-припев': 'Pre-Chorus',
  'chorus': 'Chorus', 'припев': 'Chorus', 'hook': 'Chorus', 'хук': 'Chorus', 'final chorus': 'Chorus',
  'post-chorus': 'Post-Chorus', 'постприпев': 'Post-Chorus',
  'bridge': 'Bridge', 'бридж': 'Bridge', 'мост': 'Bridge', 'переход': 'Bridge',
  'outro': 'Outro', 'аутро': 'Outro', 'концовка': 'Outro', 'финал': 'Outro', 'кода': 'Outro', 'окончание': 'Outro',
  'instrumental': 'Instrumental', 'инструментал': 'Instrumental', 'проигрыш': 'Instrumental', 'инструментальная часть': 'Instrumental',
  'interlude': 'Interlude', 'интерлюдия': 'Interlude',
  'guitar solo': 'Guitar Solo', 'гитарное соло': 'Guitar Solo', 'соло гитары': 'Guitar Solo', 'соло': 'Guitar Solo', 'solo': 'Guitar Solo',
  'piano interlude': 'Piano Interlude', 'piano solo': 'Piano Interlude', 'соло фортепиано': 'Piano Interlude',
  'synth solo': 'Synth Solo', 'breakdown': 'Breakdown', 'брейкдаун': 'Breakdown',
  'build': 'Build', 'build-up': 'Build', 'buildup': 'Build', 'drop': 'Drop', 'дроп': 'Drop',
  'fade out': 'Fade Out', 'затухание': 'Fade Out', 'silence': 'Silence', 'тишина': 'Silence',
};

/** Теги исполнения/энергии — не начинают секцию. */
const STYLE_TAGS = new Set([
  'whispered', 'spoken word', 'raspy vocal', 'falsetto', 'powerful belting', 'harmonies', 'call and response', 'ad-lib',
  'high energy', 'low energy', 'building energy', 'explosive', 'melancholic', 'euphoric', 'dreamy', 'aggressive',
]);

export const INSTRUMENTAL_TAGS = new Set(['Intro', 'Outro', 'Instrumental', 'Interlude', 'Guitar Solo', 'Piano Interlude',
  'Synth Solo', 'Breakdown', 'Build', 'Drop', 'Fade Out', 'Silence']);

export interface TagInfo { tag: string; base: string; kind: 'section' | 'style' | 'unknown' }

export function normalizeTag(inner: string): TagInfo {
  const raw = inner.trim().replace(/\s+/g, ' ');
  const [headRaw, ...mods] = raw.split(/\s+[-–—:]\s+/);
  const head = headRaw.toLowerCase().replace(/[.:]+$/, '');
  if (STYLE_TAGS.has(head)) return { tag: head, base: head, kind: 'style' };
  const m = head.match(/^(.*?)[\s#№]*(\d+)?$/);
  const word = (m?.[1] ?? head).trim();
  const num = m?.[2];
  const base = SECTION_ALIASES[word] ?? SECTION_ALIASES[head];
  if (!base) return { tag: raw, base: raw, kind: 'unknown' };
  let tag = base === 'Verse' && num ? `Verse ${num}` : base;
  const mod = mods.join(' ').trim();
  if (mod && mod.split(/\s+/).length <= 3 && /^[a-z\s-]+$/i.test(mod)) tag += ` - ${mod.toLowerCase()}`;
  return { tag, base, kind: 'section' };
}

const TAG_LINE = /^\s*\[([^\]]+)\]\s*$/;
const HEADER_LINE = /^\s*([A-Za-zА-Яа-яЁё\- ]{3,24}?)\s*(\d+)?\s*:\s*$/;

function detectHeader(line: string): TagInfo | null {
  const t = line.match(TAG_LINE);
  if (t) return normalizeTag(t[1]);
  const h = line.match(HEADER_LINE);
  if (h) {
    const info = normalizeTag(h[2] ? `${h[1]} ${h[2]}` : h[1]);
    if (info.kind === 'section') return info;
  }
  return null;
}

export interface TaggedBlock { tag: string; base: string; lines: string[] }

/** Разбор текста с тегами на блоки: [Verse 1] + строки. Теги исполнения пропускаются. */
export function splitTagged(text: string): TaggedBlock[] {
  const blocks: TaggedBlock[] = [];
  let cur: TaggedBlock | null = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = detectHeader(line);
    if (h) {
      if (h.kind === 'style') continue;
      cur = { tag: h.tag, base: h.kind === 'unknown' ? 'Verse' : h.base, lines: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) { cur = { tag: 'Verse', base: 'Verse', lines: [] }; blocks.push(cur); }
    cur.lines.push(line);
  }
  return blocks;
}

// ───────────────────────── Слоги ─────────────────────────

const CYR_VOWELS = /[аеёиоуыэюяіїєАЕЁИОУЫЭЮЯІЇЄ]/g;
const LAT_VOWEL_GROUPS = /[aeiouyàâäéèêëîïôöùûüáíóúãõåæøœ]+/gi;
const CJK = /[぀-ヿ㐀-鿿가-힯]/g;

export function countSyllables(line: string): number {
  const cyr = line.match(CYR_VOWELS)?.length ?? 0;
  const cjk = line.match(CJK)?.length ?? 0;
  let lat = 0;
  for (const w of line.match(/[A-Za-zÀ-ÿ']+/g) ?? []) {
    let n = w.match(LAT_VOWEL_GROUPS)?.length ?? 0;
    if (n > 1 && /[^aeiouy]e$/i.test(w)) n--; // немая e в конце
    lat += Math.max(1, n);
  }
  return cyr + cjk + lat;
}

function sylLimits(lang: string) {
  return lang === 'ru' || lang === 'uk' ? { warn: 13, bad: 16 } : { warn: 12, bad: 15 };
}

// ───────────────────────── Числа словами ─────────────────────────

const RU_UNITS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const RU_TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const RU_TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const RU_HUND = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

function ruUnder1000(n: number): string[] {
  const out: string[] = [];
  if (n >= 100) out.push(RU_HUND[Math.floor(n / 100)]);
  const r = n % 100;
  if (r >= 10 && r < 20) out.push(RU_TEENS[r - 10]);
  else {
    if (r >= 20) out.push(RU_TENS[Math.floor(r / 10)]);
    if (r % 10 && (r >= 20 || r < 10)) out.push(RU_UNITS[r % 10]);
  }
  return out;
}

export function ruNumber(n: number): string {
  if (n === 0) return 'ноль';
  const out: string[] = [];
  const th = Math.floor(n / 1000);
  if (th) {
    const r10 = th % 10, r100 = th % 100;
    const words = ruUnder1000(th);
    if (r100 < 10 || r100 >= 20) {
      if (r10 === 1) words[words.length - 1] = 'одна';
      if (r10 === 2) words[words.length - 1] = 'две';
    }
    const form = r100 >= 11 && r100 <= 19 ? 'тысяч' : r10 === 1 ? 'тысяча' : r10 >= 2 && r10 <= 4 ? 'тысячи' : 'тысяч';
    if (th === 1) out.push('тысяча'); else out.push(...words, form);
  }
  out.push(...ruUnder1000(n % 1000));
  return out.join(' ');
}

const EN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function enNumber(n: number): string {
  if (n < 20) return EN_UNITS[n];
  if (n < 100) return EN_TENS[Math.floor(n / 10)] + (n % 10 ? '-' + EN_UNITS[n % 10] : '');
  if (n < 1000) return EN_UNITS[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + enNumber(n % 100) : '');
  return enNumber(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + enNumber(n % 1000) : '');
}

function digitsToWords(line: string, lang: string): string {
  if (lang !== 'ru' && lang !== 'en') return line;
  return line.replace(/\d{1,4}/g, (d) => (lang === 'ru' ? ruNumber(Number(d)) : enNumber(Number(d))));
}

// ───────────────────────── Очистка ─────────────────────────

export interface SanitizeOptions { allowBacking: boolean; lang: string }

function cleanTextLine(line: string, o: SanitizeOptions): string {
  let s = line;
  s = s.replace(/\*[^*]*\*/g, ' '); // *ремарки*
  s = s.replace(/^\s*(?:[-–—•·*>]+|\d+[.)])\s*/, ''); // маркеры списка, тире диалога
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/<[^>]*>/g, ' ');
  if (!o.allowBacking) s = s.replace(/\([^)]*\)/g, ' ');
  // непарные скобки
  if (o.allowBacking) {
    const open = (s.match(/\(/g) ?? []).length, close = (s.match(/\)/g) ?? []).length;
    if (open !== close) s = s.replace(/[()]/g, ' ');
  } else s = s.replace(/[()]/g, ' ');
  s = s.replace(/[\[\]{}*_~#|]/g, ' ');
  s = s.replace(/[«»"“”„`]/g, '');
  s = s.replace(/(^|[^\p{L}])['‘’]|['‘’](?=[^\p{L}]|$)/gu, '$1'); // кавычки-апострофы вне слов
  s = s.replace(/\s*(?:\.{2,}|…)\s*(?=\S)/g, ', ').replace(/\s*(?:\.{2,}|…)\s*$/g, '');
  s = digitsToWords(s, o.lang);
  s = s.replace(/\s+([,!?;:.])/g, '$1').replace(/([,;:])\1+/g, '$1').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^[,;:.\-–—\s]+/, '').replace(/[,;:\-–—\s]+$/, '');
  return s;
}

function splitLong(line: string, lang: string): string[] {
  const { bad } = sylLimits(lang);
  if (countSyllables(line) < bad) return [line];
  const commas = [...line.matchAll(/[,;]\s/g)].map((m) => m.index!);
  if (!commas.length) return [line];
  const mid = line.length / 2;
  const at = commas.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
  const a = line.slice(0, at).trim(), b = line.slice(at + 1).trim();
  if (countSyllables(a) < 4 || countSyllables(b) < 4) return [line];
  return [a, b.charAt(0).toLocaleUpperCase() + b.slice(1)];
}

export interface SanitizeResult { text: string; changes: number }

export function sanitizeLyrics(text: string, o: SanitizeOptions): SanitizeResult {
  const out: string[] = [];
  let changes = 0;
  for (const rawLine of text.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = detectHeader(line);
    if (header) {
      let tagLine: string;
      if (header.kind === 'unknown') tagLine = '[Verse]';
      else tagLine = `[${header.tag}]`;
      if (tagLine !== line) changes++;
      if (header.kind !== 'style' && out.length) out.push('');
      out.push(tagLine);
      continue;
    }
    const cleaned = cleanTextLine(line, o);
    if (cleaned !== line) changes++;
    if (!cleaned || !/[\p{L}]/u.test(cleaned)) continue;
    const parts = splitLong(cleaned, o.lang);
    if (parts.length > 1) changes++;
    out.push(...parts);
  }
  // убрать двойные пустые строки
  const text2 = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: text2 || '[Instrumental]', changes };
}

// ───────────────────────── Анализ ─────────────────────────

export type Level = 'ok' | 'warn' | 'bad';

export interface LineInfo {
  type: 'tag' | 'style' | 'text' | 'empty';
  syll?: number;
  level: Level;
  note?: string;
}

export interface LyricsWarning { line: number; level: Level; message: string }

export interface LyricsAnalysis {
  lines: LineInfo[];
  warnings: LyricsWarning[];
  vocalLines: number;
  estimatedSec: number;
  targetSec: number;
  sections: { tag: string; lines: number }[];
}

export function analyzeLyrics(text: string, p: TrackParams): LyricsAnalysis {
  const t = timing(p);
  const lim = sylLimits(p.language);
  const rows = text.replace(/\r/g, '').split('\n');
  const lines: LineInfo[] = [];
  const warnings: LyricsWarning[] = [];
  const sections: { tag: string; lines: number }[] = [];
  let current: { tag: string; lines: number } | null = null;
  const cyrLang = p.language === 'ru' || p.language === 'uk';

  rows.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) { lines.push({ type: 'empty', level: 'ok' }); return; }
    const header = detectHeader(line);
    if (header) {
      if (header.kind === 'style') { lines.push({ type: 'style', level: 'ok' }); return; }
      if (header.kind === 'unknown') {
        lines.push({ type: 'tag', level: 'warn', note: 'Неизвестный тег' });
        warnings.push({ line: i, level: 'warn', message: `Тег [${header.tag}] не понятен модели — будет заменён на [Verse]` });
      } else lines.push({ type: 'tag', level: 'ok' });
      current = { tag: header.kind === 'unknown' ? 'Verse' : header.tag, lines: 0 };
      sections.push(current);
      return;
    }
    if (!current) { current = { tag: 'Verse', lines: 0 }; sections.push(current); }
    const pureBacking = line.replace(/\([^)]*\)/g, '').trim() === '';
    // строка целиком в скобках — бэк-вокал: без разрешения удаляется, с разрешением звучит поверх
    current.lines += pureBacking ? (p.allowBacking ? 0.5 : 0) : 1;
    const syll = countSyllables(line);
    let level: Level = syll >= lim.bad ? 'bad' : syll >= lim.warn ? 'warn' : 'ok';
    const notes: string[] = [];
    if (level !== 'ok') notes.push(`${syll} слогов — длинная строка, слова могут «проглатываться»`);
    if (syll > 0 && syll < 3) { notes.push('Очень короткая строка'); level = level === 'ok' ? 'warn' : level; }
    if (/[()]/.test(line)) {
      notes.push(p.allowBacking ? 'Скобки = бэк-вокал (может звучать другим голосом)' : 'Текст в скобках будет удалён (бэк-вокал выключен)');
      if (level === 'ok') level = 'warn';
    }
    if (/\*[^*]+\*|\[[^\]]+\]|\{[^}]+\}/.test(line)) { notes.push('Ремарка внутри строки будет удалена'); level = 'bad'; }
    if (/\d/.test(line)) { notes.push('Цифры будут заменены словами'); if (level === 'ok') level = 'warn'; }
    if (/[«»"“”]/.test(line)) { notes.push('Кавычки будут удалены'); if (level === 'ok') level = 'warn'; }
    if (cyrLang && /[A-Za-z]{2,}/.test(line)) { notes.push('Латиница в русском тексте может читаться неверно'); if (level === 'ok') level = 'warn'; }
    lines.push({ type: 'text', syll, level, note: notes.join(' · ') || undefined });
    if (level !== 'ok') warnings.push({ line: i, level, message: notes.join(' · ') });
  });

  const plan = planStructure(p);
  const planBars = new Map<string, number[]>();
  for (const ps of plan.sections) if (ps.kind === 'instrumental') planBars.set(ps.tag, [...(planBars.get(ps.tag) ?? []), ps.bars]);
  let est = 0;
  let vocalLines = 0;
  for (const s of sections) {
    const base = s.tag.split(' - ')[0];
    if (s.lines === 0) {
      const fromPlan = planBars.get(base)?.shift();
      if (INSTRUMENTAL_TAGS.has(base)) est += (fromPlan ?? (base === 'Fade Out' || base === 'Silence' ? 2 : 8)) * t.barSec;
    } else {
      vocalLines += s.lines;
      est += s.lines * t.lineSec + t.gapSec;
    }
  }
  if (!sections.length && !text.trim()) est = 0;
  const vocalSections = sections.filter((s) => s.lines > 0);
  if (vocalSections.length && est < p.duration * 0.8) {
    warnings.unshift({ line: -1, level: 'bad', message: `Текста мало: хватит примерно на ${fmtTime(est)} из ${fmtTime(p.duration)} — конец трека будет без вокала` });
  } else if (vocalSections.length && est > p.duration * 1.12) {
    warnings.unshift({ line: -1, level: 'warn', message: `Текста больше, чем помещается (≈${fmtTime(est)} из ${fmtTime(p.duration)}) — конец может обрезаться` });
  }
  return { lines, warnings, vocalLines, estimatedSec: est, targetSec: p.duration, sections };
}

// ───────────────────────── Разбор ответа LLM и сборка ─────────────────────────

export interface ParsedLyrics { title: string; sections: Partial<Record<UniqueKey, string[]>> }

export function stripThink(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
}

export function parseLlmLyrics(raw: string): ParsedLyrics {
  const text = stripThink(raw);
  let title = '';
  const sections: Partial<Record<UniqueKey, string[]>> = {};
  let cur: UniqueKey | null = null;
  let verseNo = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().replace(/^\*\*(.*)\*\*$/, '$1');
    if (!line) continue;
    const tm = line.match(/^(?:title|название|заголовок)\s*[:：]\s*(.+)$/i);
    if (tm && !title) { title = tm[1].replace(/[«»"“”*]/g, '').trim(); continue; }
    const header = detectHeader(line);
    if (header) {
      cur = null;
      if (header.kind !== 'section') continue;
      const base = header.tag.split(' - ')[0];
      if (base.startsWith('Verse')) {
        const n = Number(base.split(' ')[1]) || verseNo + 1;
        verseNo = n;
        const key = (`V${Math.min(n, 3)}`) as UniqueKey;
        cur = sections[key] ? null : key;
      } else if (base === 'Chorus') cur = sections.C ? null : 'C';
      else if (base === 'Pre-Chorus') cur = sections.P ? null : 'P';
      else if (base === 'Bridge') cur = sections.B ? null : 'B';
      if (cur) sections[cur] = [];
      continue;
    }
    if (cur) sections[cur]!.push(line);
  }
  return { title, sections };
}

export interface AssembleResult { text: string; missing: string[] }

export function assembleLyrics(plan: StructurePlan, parsed: ParsedLyrics): AssembleResult {
  const blocks: string[] = [];
  const missing = new Set<string>();
  for (const s of plan.sections) {
    if (s.kind === 'instrumental') { blocks.push(`[${s.tag}]`); continue; }
    const lines = s.key ? parsed.sections[s.key] : undefined;
    if (!lines || !lines.length) { missing.add(s.tag); continue; }
    blocks.push(`[${s.tag}]\n${lines.join('\n')}`);
  }
  return { text: blocks.join('\n\n'), missing: [...missing] };
}

// ───────────────────────── Утилиты ─────────────────────────

export function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)); }

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
