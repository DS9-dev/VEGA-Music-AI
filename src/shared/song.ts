/**
 * Песня из аудио (V3):
 *  - слова с временем (Whisper) → строки → секции (куплеты, припевы, проигрыши);
 *  - текст с тегами для редактора;
 *  - исправление распознанного текста языковой моделью;
 *  - «бюджет» слогов по секциям и переписывание текста на новую тему.
 */
import { KEYS, langDef } from './catalog';
import { clamp, countSyllables, fmtTime, normalizeTag, splitTagged, stripThink } from './lyrics';
import { matureBlock, PLAIN_LINE_RULES } from './prompts';
import type { SectionBudget, Song, SongLine, SongSection, SongWord, TrackParams } from './types';

// ───────────────────────── слова → строки ─────────────────────────

const barOf = (bpm: number | null | undefined) => 240 / (bpm && bpm > 30 ? bpm : 100);

/** Галлюцинации Whisper на тишине и проигрышах. */
const HALLUCINATIONS = [
  /продолжение следует/i, /субтитр/i, /редактор субтитров/i, /спасибо за просмотр/i, /подписывайтесь/i, /ставьте лайк/i,
  /dimatorzok/i, /amara\.org/i, /thanks? for watching/i, /subscribe/i, /^\s*музыка\s*$/i, /^\s*\[?music\]?\s*$/i,
];

export function isHallucination(text: string): boolean {
  return HALLUCINATIONS.some((r) => r.test(text));
}

function cleanWord(w: string): string {
  return w.replace(/[♪♫*«»"“”„]/g, '').replace(/\s+/g, ' ').trim();
}

/** Слова → строки по паузам и длине (строка песни ≈ 2 такта). */
export function buildLines(words: SongWord[], bpm: number | null): SongLine[] {
  const bar = barOf(bpm);
  const gapLine = clamp(0.3 * bar, 0.35, 0.9);
  const maxDur = clamp(2.4 * bar, 4, 8);
  const lines: SongLine[] = [];
  let cur: { words: string[]; start: number; end: number } | null = null;
  const flush = () => {
    if (!cur) return;
    let text = cur.words.join(' ').replace(/\s+([,.!?…:;])/g, '$1').replace(/[,.;:…]+$/g, '').trim();
    if (text) {
      text = text[0].toLocaleUpperCase() + text.slice(1);
      lines.push({ text, start: round2(cur.start), end: round2(cur.end) });
    }
    cur = null;
  };
  const sorted = words.map((w) => ({ ...w, w: cleanWord(w.w) })).filter((w) => w.w && Number.isFinite(w.s)).sort((a, b) => a.s - b.s);
  for (const w of sorted) {
    if (cur) {
      const gap = w.s - cur.end;
      const dur = cur.end - cur.start;
      const prev = cur.words[cur.words.length - 1] ?? '';
      if (gap > gapLine || (dur > maxDur && gap > 0.12) || cur.words.length >= 14 || (/[.!?]$/.test(prev) && dur > 0.6 * maxDur && gap > 0.08)) flush();
    }
    if (!cur) cur = { words: [], start: w.s, end: w.e };
    cur.words.push(w.w);
    cur.end = Math.max(cur.end, w.e);
  }
  flush();
  return lines.filter((l) => !isHallucination(l.text));
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// ───────────────────────── строки → секции ─────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); m.set(b, (m.get(b) ?? 0) + 1); }
  return m;
}

/** Похожесть строк 0..1 (коэффициент Дайса по биграммам). */
export function lineSimilarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const A = bigrams(x), B = bigrams(y);
  let inter = 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return (2 * inter) / (x.length - 1 + y.length - 1);
}

/** Похожесть блоков: средняя лучшая похожесть строк в обе стороны. */
export function blockSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const side = (p: string[], q: string[]) => p.reduce((acc, l) => acc + Math.max(...q.map((m) => lineSimilarity(l, m))), 0) / p.length;
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return ((side(a, b) + side(b, a)) / 2) * (0.75 + 0.25 * lenRatio);
}

/** Делит слишком длинный блок по самой длинной паузе. */
function splitBlock(block: SongLine[], maxLines = 12): SongLine[][] {
  if (block.length <= maxLines) return [block];
  let best = Math.floor(block.length / 2), bestGap = -1;
  for (let i = Math.max(2, Math.floor(block.length * 0.3)); i <= Math.min(block.length - 2, Math.ceil(block.length * 0.7)); i++) {
    const gap = block[i].start - block[i - 1].end;
    if (gap > bestGap) { bestGap = gap; best = i; }
  }
  return [...splitBlock(block.slice(0, best), maxLines), ...splitBlock(block.slice(best), maxLines)];
}

/**
 * Куплет часто переходит в припев без паузы — тогда они попадают в один блок.
 * Строки, которые повторяются в других блоках (припев), отделяются от неповторяющихся.
 */
export function splitByRepeats(blocks: SongLine[][]): SongLine[][] {
  const flat = blocks.flatMap((b, bi) => b.map((l, li) => ({ l, bi, li })));
  const repeated = flat.map((x) => flat.some((y) => y !== x && (y.bi !== x.bi || Math.abs(y.li - x.li) >= 4) && lineSimilarity(x.l.text, y.l.text) >= 0.8));
  const out: SongLine[][] = [];
  let k = 0;
  for (const b of blocks) {
    const flags = b.map(() => repeated[k++]);
    const runs: { rep: boolean; lines: SongLine[] }[] = [];
    b.forEach((l, i) => {
      const last = runs[runs.length - 1];
      if (last && last.rep === flags[i]) last.lines.push(l);
      else runs.push({ rep: flags[i], lines: [l] });
    });
    // короткие вкрапления (1 строка) не режут блок
    const merged: { rep: boolean; lines: SongLine[] }[] = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && (r.lines.length < 2 || last.lines.length < 2)) { last.lines.push(...r.lines); last.rep = last.lines.length >= r.lines.length ? last.rep : r.rep; }
      else merged.push({ ...r, lines: [...r.lines] });
    }
    out.push(...merged.map((r) => r.lines));
  }
  return out;
}

export function buildSections(lines: SongLine[], duration: number, bpm: number | null): SongSection[] {
  const bar = barOf(bpm);
  const blockGap = Math.max(2.2, 1.4 * bar);
  const raw: SongLine[][] = [];
  for (const l of lines) {
    const last = raw[raw.length - 1];
    if (last && l.start - last[last.length - 1].end <= blockGap) last.push(l);
    else raw.push([l]);
  }
  const blocks = splitByRepeats(raw).flatMap((b) => splitBlock(b));

  // группы повторов (union-find по похожести)
  const parent = blocks.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (blockSimilarity(blocks[i].map((l) => l.text), blocks[j].map((l) => l.text)) >= 0.55) parent[find(j)] = find(i);
    }
  }
  const members = new Map<number, number[]>();
  blocks.forEach((_, i) => members.set(find(i), [...(members.get(find(i)) ?? []), i]));
  const repeated = [...members.values()].filter((m) => m.length >= 2)
    .sort((a, b) => b.length - a.length || blocks[b[0]].length - blocks[a[0]].length);

  const tagOf: string[] = new Array(blocks.length).fill('');
  const groupOf: (string | undefined)[] = new Array(blocks.length).fill(undefined);
  repeated.forEach((m, gi) => {
    let tag = 'Chorus';
    if (gi > 0) {
      const chorus = new Set(repeated[0]);
      if (m.every((i) => chorus.has(i + 1))) tag = 'Pre-Chorus';
      else if (m.every((i) => chorus.has(i - 1))) tag = 'Post-Chorus';
      else tag = 'Post-Chorus';
    }
    for (const i of m) { tagOf[i] = tag; groupOf[i] = `g${gi + 1}`; }
  });
  const chorusIdx = repeated[0] ?? [];
  let verse = 0;
  blocks.forEach((b, i) => {
    if (tagOf[i]) return;
    const choruses = chorusIdx.filter((c) => c < i).length;
    const late = chorusIdx.length >= 2 && choruses >= 2 && i < blocks.length - 1 && b.length <= 6 && verse >= 2;
    if (late) tagOf[i] = 'Bridge';
    else tagOf[i] = `Verse ${++verse}`;
  });

  const out: SongSection[] = [];
  const instGap = Math.max(8, 4 * bar);
  blocks.forEach((b, i) => {
    const start = b[0].start;
    const prevEnd = i === 0 ? 0 : blocks[i - 1][blocks[i - 1].length - 1].end;
    if (i === 0 && start > Math.max(4, 2 * bar)) out.push({ tag: 'Intro', kind: 'instrumental', start: 0, end: round2(start), lines: [] });
    else if (i > 0 && start - prevEnd > instGap) out.push({ tag: 'Instrumental', kind: 'instrumental', start: round2(prevEnd), end: round2(start), lines: [] });
    out.push({ tag: tagOf[i], kind: 'vocal', start: round2(start), end: round2(b[b.length - 1].end), lines: b, group: groupOf[i] });
  });
  const lastEnd = blocks.length ? blocks[blocks.length - 1][blocks[blocks.length - 1].length - 1].end : 0;
  if (blocks.length && duration - lastEnd > Math.max(5, 2 * bar)) out.push({ tag: 'Outro', kind: 'instrumental', start: round2(lastEnd), end: round2(duration), lines: [] });
  if (!blocks.length) out.push({ tag: 'Instrumental', kind: 'instrumental', start: 0, end: round2(duration), lines: [] });
  return out;
}

export function sectionsToLyrics(sections: SongSection[]): string {
  return sections.map((s) => (s.kind === 'instrumental' ? `[${s.tag}]` : `[${s.tag}]\n${s.lines.map((l) => l.text).join('\n')}`)).join('\n\n');
}

export function vocalSections(sections: SongSection[]): SongSection[] {
  return sections.filter((s) => s.kind === 'vocal');
}

/** Перенос правок текста (по порядку вокальных секций) на секции с таймингом. */
export function sectionsWithText(sections: SongSection[], text: string): SongSection[] {
  const blocks = splitTagged(text).filter((b) => b.lines.length);
  const voc = vocalSections(sections);
  if (blocks.length !== voc.length) return sections;
  let k = 0;
  return sections.map((s) => {
    if (s.kind !== 'vocal') return s;
    const b = blocks[k++];
    const n = b.lines.length;
    const span = (s.end - s.start) / Math.max(1, n);
    const tag = normalizeTag(b.tag);
    return {
      ...s,
      tag: tag.kind === 'section' ? tag.tag : s.tag,
      lines: b.lines.map((t, i) => ({ text: t, start: s.lines[i]?.start ?? round2(s.start + i * span), end: s.lines[i]?.end ?? round2(s.start + (i + 1) * span) })),
    };
  });
}

// ───────────────────────── исправление распознанного текста ─────────────────────────

export function cleanupMessages(sections: SongSection[], language: string) {
  const voc = vocalSections(sections);
  const lang = langDef(language).en;
  const blocks = voc.map((s, i) => `#${i + 1} (${fmtTime(s.start)}–${fmtTime(s.end)}, guess: ${s.tag})\n${s.lines.map((l) => l.text).join('\n')}`).join('\n\n');
  const system = [
    'You restore song lyrics that were transcribed automatically by speech recognition from an isolated vocal track.',
    `The song is in ${lang}.`,
    'TASK 1: fix obvious recognition errors — misheard or broken words, wrong word boundaries, nonsense words — using rhyme, meaning and context.',
    'Do NOT rewrite the song, do not improve or censor it, do not change the meaning. Keep the number of lines in every block EXACTLY the same, one output line per input line.',
    'TASK 2: label every block with one tag: Verse, Pre-Chorus, Chorus, Post-Chorus or Bridge. Blocks that repeat (the hook) are Chorus.',
    '',
    'OUTPUT FORMAT (strict, nothing else):',
    '#1 [Verse]',
    'line',
    'line',
    '',
    '#2 [Chorus]',
    'line',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${blocks}\n\nReturn all ${voc.length} blocks. /no_think` },
  ];
}

const VOCAL_BASES = new Set(['Verse', 'Pre-Chorus', 'Chorus', 'Post-Chorus', 'Bridge']);

/** Применяет ответ модели: исправленные строки (если число строк совпало) и теги. */
export function applyCleanup(sections: SongSection[], raw: string): { sections: SongSection[]; fixedBlocks: number } {
  const text = stripThink(raw);
  const parsed = new Map<number, { tag: string | null; lines: string[] }>();
  let cur: { tag: string | null; lines: string[] } | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const h = line.match(/^#\s*(\d+)\s*(?:\[([^\]]+)\]|[:\-–—]?\s*([A-Za-z\- ]+))?\s*$/);
    if (h) {
      const info = h[2] || h[3] ? normalizeTag(h[2] ?? h[3]) : null;
      cur = { tag: info && info.kind === 'section' && VOCAL_BASES.has(info.base) ? info.base : null, lines: [] };
      parsed.set(Number(h[1]), cur);
      continue;
    }
    if (cur && !/^\[[^\]]+\]$/.test(line)) cur.lines.push(line.replace(/^[-•]\s+/, ''));
  }
  let k = 0;
  let fixedBlocks = 0;
  const next = sections.map((s) => {
    if (s.kind !== 'vocal') return s;
    const p = parsed.get(++k);
    if (!p) return s;
    let lines = s.lines;
    if (p.lines.length === s.lines.length && p.lines.every((l) => l.length > 0 && l.length < 200)) {
      lines = s.lines.map((l, i) => ({ ...l, text: p.lines[i] }));
      fixedBlocks++;
    }
    return { ...s, lines, tag: p.tag ?? s.tag };
  });
  return { sections: relabel(next), fixedBlocks };
}

/** Нумерация куплетов и группы повторов по тегам. */
export function relabel(sections: SongSection[]): SongSection[] {
  let verse = 0;
  return sections.map((s) => {
    if (s.kind !== 'vocal') return s;
    const base = normalizeTag(s.tag).base;
    if (base === 'Verse') return { ...s, tag: `Verse ${++verse}`, group: undefined };
    if (base === 'Chorus' || base === 'Pre-Chorus' || base === 'Post-Chorus') return { ...s, tag: base, group: base };
    return { ...s, tag: base, group: undefined };
  });
}

// ───────────────────────── бюджет слогов ─────────────────────────

const syl = (lines: string[]) => lines.reduce((a, l) => a + countSyllables(l), 0);

/** Сколько слогов должно быть в каждой вокальной секции, чтобы слова легли в такт. */
export function sectionBudgets(sections: SongSection[], text?: string): SectionBudget[] {
  const src = text ? sectionsWithText(sections, text) : sections;
  const voc = vocalSections(src);
  const rates = voc.map((s) => syl(s.lines.map((l) => l.text)) / Math.max(1, s.end - s.start)).filter((r) => r > 0.5 && r < 9).sort((a, b) => a - b);
  const rate = rates.length ? rates[Math.floor(rates.length / 2)] : 3.2;
  return voc.map((s) => {
    const original = syl(s.lines.map((l) => l.text));
    const dur = Math.max(1, s.end - s.start);
    // секция почти без слов — распознавание пропустило текст, считаем по средней плотности
    const target = original < 0.4 * dur * rate ? Math.round(dur * rate) : original;
    return { tag: s.tag, group: s.group, start: s.start, end: s.end, target: Math.max(4, target), original };
  });
}

/** Фактическое число слогов нового текста по секциям (по порядку). */
export function measureBudgets(budgets: SectionBudget[], text: string): SectionBudget[] {
  const blocks = splitTagged(text).filter((b) => b.lines.length);
  return budgets.map((b, i) => ({ ...b, actual: blocks[i] ? syl(blocks[i].lines) : 0 }));
}

export function budgetLevel(b: SectionBudget): 'ok' | 'warn' | 'bad' {
  if (b.actual == null) return 'ok';
  const d = Math.abs(b.actual - b.target) / Math.max(1, b.target);
  return d <= 0.12 ? 'ok' : d <= 0.25 ? 'warn' : 'bad';
}

// ───────────────────────── переписывание на тему ─────────────────────────

export interface UniquePart {
  name: string; // заголовок для модели (уникальный)
  tag: string; // тег в итоговом тексте
  key: string; // группа повторов или индекс секции
  target: number;
  lines: string[]; // оригинальные строки
  repeats: number;
  start: number;
  end: number;
}

export function uniqueParts(sections: SongSection[], text?: string): UniquePart[] {
  const src = text ? sectionsWithText(sections, text) : sections;
  const budgets = sectionBudgets(src);
  const parts: UniquePart[] = [];
  const names = new Set<string>();
  vocalSections(src).forEach((s, i) => {
    const key = s.group ?? `s${i}`;
    const existing = parts.find((p) => p.key === key);
    if (existing) { existing.repeats++; return; }
    let name = s.tag;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${s.tag} ${n}`;
    names.add(name.toLowerCase());
    parts.push({ name, tag: s.tag, key, target: budgets[i].target, lines: s.lines.map((l) => l.text), repeats: 1, start: s.start, end: s.end });
  });
  return parts;
}

export function rewriteMessages(song: Pick<Song, 'language' | 'title' | 'bpm' | 'gender'>, parts: UniquePart[], theme: string, matureDark: boolean) {
  const lang = langDef(song.language);
  const system = [
    'You are an award-winning professional songwriter. You rewrite existing songs on a NEW topic so that the new lyrics can be sung over the ORIGINAL music.',
    `Write ALL sung lines in ${lang.en} only.${lang.code === 'ru' ? ' Use natural, modern, idiomatic Russian with correct word stress that falls naturally on strong beats.' : ''}`,
    '',
    'KEEP THE MUSICAL SKELETON:',
    '- The same sections in the same order, with exactly the section headers given below.',
    '- Each section must have about the TARGET number of syllables (±10%). This is the most important rule: it makes the words fit the beat. Count syllables carefully.',
    '- The number of lines may differ from the original, but similar line lengths and a similar rhyme scheme work best.',
    '- A section that is sung several times (the chorus) is written ONCE; it will be repeated automatically.',
    '- The chorus is catchy and contains the main hook of the new topic.',
    '- Completely new words and story on the new topic: do not reuse lines or rhymes of the original.',
    ...PLAIN_LINE_RULES,
    '',
    'OUTPUT FORMAT (strict, nothing else):',
    `TITLE: <short song title in ${lang.en}>`,
    '[Section header]',
    'line',
    'line',
    '',
    matureBlock(matureDark),
  ].join('\n');
  const spec = parts.map((p) => {
    const rep = p.repeats > 1 ? `, sung ${p.repeats} times — write it once` : '';
    return `[${p.name}] — TARGET ≈ ${p.target} syllables (original: ${p.lines.length} lines, ${fmtTime(p.end - p.start)} of singing${rep}). Original for rhythm reference:\n${p.lines.join('\n')}`;
  }).join('\n\n');
  const user = [
    `NEW TOPIC / what the new lyrics must be about:\n${theme.trim() || 'Free choice — surprise me with an unexpected topic.'}`,
    '',
    `Singer: ${song.gender === 'female' ? 'female' : song.gender === 'male' ? 'male' : 'unknown'}${song.bpm ? ` · tempo ${song.bpm} BPM` : ''}`,
    '',
    'Sections to write, in this order:',
    spec,
    '',
    'Write the new lyrics now. /no_think',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export interface ParsedRewrite { title: string; parts: Map<string, string[]> }

/** Разбор ответа: секции сопоставляются с заголовками из запроса. */
export function parseRewrite(raw: string, parts: UniquePart[]): ParsedRewrite {
  const text = stripThink(raw);
  const out = new Map<string, string[]>();
  let title = '';
  let cur: string[] | null = null;
  const byName = new Map(parts.map((p) => [p.name.toLowerCase().replace(/\s+/g, ' '), p]));
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().replace(/^\*\*(.*)\*\*$/, '$1');
    if (!line) continue;
    const tm = line.match(/^(?:title|название|заголовок)\s*[:：]\s*(.+)$/i);
    if (tm && !title) { title = tm[1].replace(/[«»"“”*]/g, '').trim(); continue; }
    const h = line.match(/^\[([^\]]+)\]\s*(?:[—–-].*)?$/) ?? line.match(/^([A-Za-z\- ]{3,24}\d*)\s*:\s*$/);
    if (h) {
      const inner = h[1].trim().toLowerCase().replace(/\s+/g, ' ');
      let p = byName.get(inner);
      if (!p) {
        const info = normalizeTag(h[1]);
        p = parts.find((x) => !out.has(x.key) && normalizeTag(x.name).tag === info.tag)
          ?? parts.find((x) => !out.has(x.key) && normalizeTag(x.name).base === info.base);
      }
      if (p && !out.has(p.key)) { cur = []; out.set(p.key, cur); } else cur = null;
      continue;
    }
    if (cur) cur.push(line);
  }
  return { title, parts: out };
}

export interface RewriteCheck { part: UniquePart; actual: number; level: 'ok' | 'warn' | 'bad' }

export function checkRewrite(parts: UniquePart[], parsed: ParsedRewrite): RewriteCheck[] {
  return parts.map((p) => {
    const lines = parsed.parts.get(p.key) ?? [];
    const actual = syl(lines);
    return { part: p, actual, level: budgetLevel({ tag: p.tag, start: 0, end: 0, target: p.target, original: 0, actual }) };
  });
}

export function fixMessage(bad: RewriteCheck[]): string {
  const rows = bad.map((c) => `[${c.part.name}] has ${c.actual} syllables, needs ≈ ${c.part.target} — ${c.actual > c.part.target ? 'shorten it' : c.actual === 0 ? 'it is missing, write it' : 'make it longer'}`);
  return `Some sections miss their syllable target:\n${rows.join('\n')}\nRewrite ONLY these sections (same headers, same topic, same format, no title). /no_think`;
}

/** Сборка полного текста по исходной структуре; припев повторяется дословно. */
export function assembleRewrite(sections: SongSection[], parts: UniquePart[], parsed: ParsedRewrite, text?: string): { text: string; missing: string[] } {
  const src = text ? sectionsWithText(sections, text) : sections;
  const missing = new Set<string>();
  let i = 0;
  const blocks = src.map((s) => {
    if (s.kind !== 'vocal') return `[${s.tag}]`;
    const key = s.group ?? `s${i}`;
    i++;
    const part = parts.find((p) => p.key === key);
    const lines = part ? parsed.parts.get(part.key) : undefined;
    if (!lines?.length) { missing.add(part?.name ?? s.tag); return `[${s.tag}]\n${s.lines.map((l) => l.text).join('\n')}`; }
    return `[${s.tag}]\n${lines.join('\n')}`;
  });
  return { text: blocks.join('\n\n'), missing: [...missing] };
}

// ───────────────────────── песня → параметры трека ─────────────────────────

export function songTrackParams(song: Song, base: TrackParams): TrackParams {
  const duration = clamp(Math.round(song.duration / 5) * 5, 30, 360);
  return {
    ...base,
    duration,
    bpm: song.bpm ? Math.round(song.bpm) : base.bpm,
    key: song.key && KEYS.includes(song.key) ? song.key : base.key,
    voice: song.gender ?? base.voice,
    timbre: song.gender && song.gender !== base.voice ? 'auto' : base.timbre,
    language: song.language || base.language,
    instrumental: false,
    sourceSongId: song.id,
    cover: false,
    coverStrength: base.coverStrength ?? 0.5,
  };
}

/** Участок перепевки для «новых слов на эту музыку»: от первой до последней фразы. */
export function vocalSpan(song: Pick<Song, 'sections' | 'duration'>): { start: number; end: number } {
  const voc = vocalSections(song.sections);
  if (!voc.length) return { start: 0, end: song.duration };
  return { start: Math.max(0, round2(voc[0].start - 0.4)), end: Math.min(song.duration, round2(voc[voc.length - 1].end + 0.8)) };
}

export function guessGender(f0: number | null | undefined): 'male' | 'female' | null {
  if (!f0) return null;
  return f0 < 205 ? 'male' : 'female';
}
