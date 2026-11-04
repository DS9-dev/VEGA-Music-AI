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

/** Союзы, которыми строка не заканчивается: они начинают следующую фразу. */
const LEADING_WORDS = new Set(['because', 'cause', 'and', 'but', 'so', 'or', 'that', 'if', 'when', 'и', 'а', 'но', 'что', 'чтобы', 'ведь', 'когда', 'если', 'где']);
const bare = (w: string) => w.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');

/** Слова, перед которыми в песне почти всегда начинается новая строка. */
const CLAUSE_STARTS = new Set(['because', 'cause', 'потому', 'ведь']);

type W = SongWord;

/** Лучшее место разреза слишком длинной строки: самая длинная пауза, бонус за знак препинания. */
function bestSplit(cur: W[], next: W): number {
  if (cur.length < 3) return cur.length;
  let best = cur.length;
  let bestScore = -1;
  for (let i = Math.max(2, Math.floor(cur.length * 0.35)); i <= cur.length; i++) {
    const after = i === cur.length ? next : cur[i];
    let score = after.s - cur[i - 1].e;
    if (/[.!?…]$/.test(cur[i - 1].w)) score += 0.4;
    else if (/[,;:]$/.test(cur[i - 1].w)) score += 0.25;
    if (LEADING_WORDS.has(bare(cur[i - 1].w))) score -= 0.3;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/**
 * Слова → строки. Разрез по паузам, по концу предложения (Whisper ставит точки), по запятой у длинной строки;
 * слишком длинная строка режется в лучшем месте, висящий союз переносится в начало следующей строки.
 */
export function buildLines(words: SongWord[], bpm: number | null): SongLine[] {
  const bar = barOf(bpm);
  const gapLine = clamp(0.3 * bar, 0.35, 0.9);
  const maxDur = clamp(2.4 * bar, 4, 8);
  const maxWords = 12;
  const ws = words.map((w) => ({ ...w, w: cleanWord(w.w) })).filter((w) => w.w && Number.isFinite(w.s)).sort((a, b) => a.s - b.s);
  const groups: W[][] = [];
  let cur: W[] = [];
  const dur = (a: W[]) => (a.length ? a[a.length - 1].e - a[0].s : 0);
  for (const w of ws) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const gap = w.s - prev.e;
      const sentence = /[.!?…]$/.test(prev.w) && cur.length >= 3;
      const comma = /[,;:]$/.test(prev.w) && dur(cur) > 0.6 * maxDur && cur.length >= 4;
      const clause = cur.length >= 4 && CLAUSE_STARTS.has(bare(w.w)) && !LEADING_WORDS.has(bare(prev.w));
      if (gap > gapLine || sentence || comma || clause) { groups.push(cur); cur = []; }
      else if (w.e - cur[0].s > maxDur || cur.length >= maxWords) {
        const k = bestSplit(cur, w);
        groups.push(cur.slice(0, k));
        cur = cur.slice(k);
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  // «…, because» + «we got…» → «…» + «because we got…»
  for (let i = 0; i < groups.length - 1; i++) {
    const g = groups[i];
    const last = g[g.length - 1];
    if (g.length > 2 && LEADING_WORDS.has(bare(last.w)) && !/[.!?,;:]$/.test(last.w) && groups[i + 1][0].s - last.e < 0.9) {
      groups[i + 1].unshift(g.pop()!);
    }
  }

  const lines: SongLine[] = [];
  groups.forEach((g, i) => {
    let text = g.map((w) => w.w).join(' ').replace(/\s+([,.!?…:;])/g, '$1').replace(/[,.;:…]+$/g, '')
      .replace(/([.!?…])\s+(\p{Lu}[\p{L}']*)/gu, (_m, p: string, word: string) => `${p === '.' ? ',' : p} ${/^I('|$)/.test(word) ? word : word[0].toLocaleLowerCase() + word.slice(1)}`).trim();
    if (!text) return;
    text = text[0].toLocaleUpperCase() + text.slice(1);
    // одиночное «bye»/«спасибо» на тишине в конце — галлюцинация Whisper
    const before = i > 0 ? g[0].s - groups[i - 1][groups[i - 1].length - 1].e : 99;
    const after = i < groups.length - 1 ? groups[i + 1][0].s - g[g.length - 1].e : 99;
    if (g.length <= 2 && before > 4 && after > 4 && /^(bye|bye-bye|thank you|thanks|пока|спасибо)[.!]*$/i.test(text)) return;
    if (isHallucination(text)) return;
    lines.push({ text, start: round2(g[0].s), end: round2(g[g.length - 1].e) });
  });
  return lines;
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

  const vocal: SongSection[] = blocks.map((b, i) => ({ tag: tagOf[i], kind: 'vocal', start: round2(b[0].start), end: round2(b[b.length - 1].end), lines: b, group: groupOf[i] }));
  return withInstrumental(vocal, duration, bpm);
}

/** Вставляет интро, проигрыши и аутро по тишине между вокальными секциями. */
export function withInstrumental(vocal: SongSection[], duration: number, bpm: number | null): SongSection[] {
  const bar = barOf(bpm);
  const out: SongSection[] = [];
  const instGap = Math.max(8, 4 * bar);
  vocal.forEach((v, i) => {
    const prevEnd = i === 0 ? 0 : vocal[i - 1].end;
    if (i === 0 && v.start > Math.max(4, 2 * bar)) out.push({ tag: 'Intro', kind: 'instrumental', start: 0, end: round2(v.start), lines: [] });
    else if (i > 0 && v.start - prevEnd > instGap) out.push({ tag: 'Instrumental', kind: 'instrumental', start: round2(prevEnd), end: round2(v.start), lines: [] });
    out.push(v);
  });
  const last = vocal[vocal.length - 1];
  if (last && duration - last.end > Math.max(5, 2 * bar)) {
    const vocalOutro = normalizeTag(last.tag).base === 'Outro';
    out.push({ tag: vocalOutro ? 'Fade Out' : 'Outro', kind: 'instrumental', start: round2(last.end), end: round2(duration), lines: [] });
  }
  if (!vocal.length) out.push({ tag: 'Instrumental', kind: 'instrumental', start: 0, end: round2(duration), lines: [] });
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

// ───────────────────────── перестройка текста моделью ─────────────────────────

/** Модель заново делит распознанный текст на строки и секции; время строк восстанавливается по словам Whisper. */
export function restructureMessages(sections: SongSection[], language: string) {
  const voc = vocalSections(sections);
  const lang = langDef(language).en;
  const blocks = voc.map((s) => `--- ${fmtTime(s.start)}–${fmtTime(s.end)} ---\n${s.lines.map((l) => l.text).join('\n')}`).join('\n');
  const system = [
    'You restore song lyrics from automatic speech recognition of an isolated vocal track.',
    `The song is in ${lang}. The words come in the correct ORDER, but line breaks and section breaks are unreliable and some words are misheard.`,
    'Time marks (--- 0:12–0:35 ---) show where the singer paused; a long pause usually starts a new section.',
    '',
    'TASKS:',
    '1. Split the text into proper song lines — one sung phrase per line, the way lyrics are printed (usually 4–12 words). Never break a phrase in the middle, never glue two phrases into one line.',
    '2. Fix obvious recognition errors (misheard words, broken words, wrong word boundaries) using rhyme, meaning and context. Keep the words in the same order.',
    '3. Do NOT invent lines, do NOT drop sung lines, do NOT rewrite, improve or censor the lyrics. Pure vocalizations (oh, uh-huh, yeah) may be left out.',
    '4. Group the lines into sections and label every section with one tag: [Verse], [Pre-Chorus], [Chorus], [Post-Chorus], [Bridge], [Interlude] (spoken parts), [Outro]. The repeated hook is [Chorus] — label every repetition of it.',
    '',
    'OUTPUT FORMAT (strict, nothing else, no time marks, no comments):',
    '[Verse]',
    'line',
    'line',
    '',
    '[Chorus]',
    'line',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${blocks}\n\nReturn the whole song. /no_think` },
  ];
}

const RESTRUCTURE_TAGS: Record<string, string> = {
  Verse: 'Verse', 'Pre-Chorus': 'Pre-Chorus', Chorus: 'Chorus', 'Post-Chorus': 'Post-Chorus', Bridge: 'Bridge',
  Interlude: 'Interlude', Outro: 'Outro', Intro: 'Intro', Breakdown: 'Bridge', Build: 'Pre-Chorus', Instrumental: '', 'Guitar Solo': '', 'Piano Interlude': '',
};

function tok(w: string): string { return bare(w).replace(/['’]/g, ''); }

function tokenMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
  if (short.length >= 3 && long.startsWith(short) && long.length - short.length <= 2) return true; // goin / going
  return short.length >= 4 && lineSimilarity(a, b) >= 0.75;
}

/** Выравнивание двух последовательностей слов (как LCS) — пары индексов совпавших слов. */
export function alignTokens(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = tokenMatch(a[i], b[j]) ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (tokenMatch(a[i], b[j]) && dp[at(i, j)] === dp[at(i + 1, j + 1)] + 1) { pairs.push([i, j]); i++; j++; }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Применяет ответ модели: новые строки и секции, время — по совпавшим словам Whisper.
 * null — ответ слишком далёк от распознанного (тогда остаётся прежняя разметка).
 */
export function applyRestructure(words: SongWord[], raw: string, duration: number, bpm: number | null): SongSection[] | null {
  const text = stripThink(raw);
  const blocks: { tag: string; lines: string[] }[] = [];
  let cur: { tag: string; lines: string[] } | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().replace(/^\*\*(.*)\*\*$/, '$1');
    if (!line || /^---.*---$/.test(line)) continue;
    const h = line.match(/^(?:#\s*\d+\s*)?\[([^\]]+)\]\s*$/);
    if (h) {
      const info = normalizeTag(h[1].replace(/:.*$/, ''));
      const base = info.kind === 'section' ? RESTRUCTURE_TAGS[info.base] ?? 'Verse' : 'Verse';
      cur = base ? { tag: base, lines: [] } : null;
      if (cur) blocks.push(cur);
      continue;
    }
    if (!cur) { cur = { tag: 'Verse', lines: [] }; blocks.push(cur); }
    const clean = line.replace(/^[-•]\s+/, '').replace(/\s*\[[^\]]*\]\s*/g, ' ').trim();
    if (clean) cur.lines.push(clean);
  }
  const outLines = blocks.flatMap((b, bi) => b.lines.map((l) => ({ bi, text: l, toks: l.split(/\s+/).map(tok).filter(Boolean) })));
  const outToks: { li: number; t: string }[] = outLines.flatMap((l, li) => l.toks.map((t) => ({ li, t })));
  const recWords = words.filter((w) => tok(w.w));
  const recToks = recWords.map((w) => tok(w.w));
  if (!outToks.length || !recToks.length) return null;
  const pairs = alignTokens(outToks.map((x) => x.t), recToks);
  if (pairs.length / outToks.length < 0.55 || pairs.length / recToks.length < 0.45) return null;

  const first = new Map<number, number>(), last = new Map<number, number>();
  for (const [oi, ri] of pairs) {
    const li = outToks[oi].li;
    if (!first.has(li)) first.set(li, ri);
    last.set(li, ri);
  }
  const timed: { bi: number; line: SongLine }[] = outLines.map((l, li) => ({
    bi: l.bi,
    line: { text: l.text, start: first.has(li) ? round2(recWords[first.get(li)!].s) : NaN, end: last.has(li) ? round2(recWords[last.get(li)!].e) : NaN },
  }));
  // строки без совпавших слов — между соседями
  timed.forEach((t, i) => {
    if (Number.isFinite(t.line.start)) return;
    const prev = timed.slice(0, i).reverse().find((x) => Number.isFinite(x.line.end));
    const next = timed.slice(i + 1).find((x) => Number.isFinite(x.line.start));
    t.line.start = prev ? prev.line.end : next ? Math.max(0, next.line.start - 2) : 0;
    t.line.end = next ? Math.max(t.line.start, next.line.start) : t.line.start + 2;
  });
  const vocal: SongSection[] = blocks.map((b, bi) => {
    const ls = timed.filter((t) => t.bi === bi).map((t) => t.line);
    return { tag: b.tag, kind: 'vocal' as const, start: ls[0]?.start ?? 0, end: ls[ls.length - 1]?.end ?? 0, lines: ls };
  }).filter((s) => s.lines.length);
  return withInstrumental(relabel(vocal), duration, bpm);
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
  variantOf?: string; // вариант припева другой длины
  lineTargets: number[]; // слогов в каждой строке (по строкам оригинала)
}

const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : 0; };

/**
 * Ключ уникальной части для каждой вокальной секции. Повторы одной группы (припев) делят текст,
 * но повтор, заметно отличающийся по длине (расширенный последний припев), получает свой ключ — «вариант».
 */
export function partKeys(src: SongSection[]): { keys: string[]; targets: Map<string, number> } {
  const voc = vocalSections(src);
  const budgets = sectionBudgets(src);
  const keys = voc.map((s, i) => s.group ?? `s${i}`);
  const byGroup = new Map<string, number[]>();
  voc.forEach((s, i) => { if (s.group) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), i]); });
  for (const [g, idx] of byGroup) {
    if (idx.length < 2) continue;
    const med = median(idx.map((i) => budgets[i].target));
    for (const i of idx) if (Math.abs(budgets[i].target - med) / Math.max(1, med) > 0.22) keys[i] = `${g}#${i}`;
  }
  const targets = new Map<string, number>();
  for (const k of new Set(keys)) targets.set(k, median(keys.flatMap((x, i) => (x === k ? [budgets[i].target] : []))));
  return { keys, targets };
}

/** Слоги по строкам оригинала, подогнанные к бюджету секции; очень длинные фразы делятся на две строки. */
export function lineTargets(lines: string[], target: number): number[] {
  let raw = lines.map((l) => Math.max(2, countSyllables(l))).flatMap((n) => (n > 16 ? [Math.ceil(n / 2), Math.floor(n / 2)] : [n]));
  if (!raw.length) raw = [target];
  const sum = raw.reduce((a, b) => a + b, 0);
  const k = target / Math.max(1, sum);
  const out = raw.map((n) => Math.max(3, Math.round(n * k)));
  return out;
}

export function uniqueParts(sections: SongSection[], text?: string): UniquePart[] {
  const src = text ? sectionsWithText(sections, text) : sections;
  const { keys, targets } = partKeys(src);
  const parts: UniquePart[] = [];
  const names = new Set<string>();
  vocalSections(src).forEach((s, i) => {
    const key = keys[i];
    const existing = parts.find((p) => p.key === key);
    if (existing) { existing.repeats++; return; }
    let name = s.tag;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${s.tag} ${n}`;
    names.add(name.toLowerCase());
    const variantOf = key.includes('#') ? parts.find((p) => p.key === key.split('#')[0])?.name ?? s.tag : undefined;
    const target = targets.get(key)!;
    parts.push({ name, tag: s.tag, key, target, lines: s.lines.map((l) => l.text), repeats: 1, start: s.start, end: s.end, variantOf, lineTargets: lineTargets(s.lines.map((l) => l.text), target) });
  });
  return parts;
}

/** Род рассказчика: в русском и украинском формы глаголов и прилагательных зависят от пола исполнителя. */
function narratorRule(gender: Song['gender'], lang: string): string {
  if (!gender) return '';
  if (lang === 'ru' || lang === 'uk') {
    return gender === 'male'
      ? '- The singer is a MAN. Every first-person past-tense verb and adjective must be masculine (я вернулся, я был один, я готов). Never mix genders.'
      : '- The singer is a WOMAN. Every first-person past-tense verb and adjective must be feminine (я вернулась, я была одна, я готова). Never mix genders.';
  }
  return `- The singer is ${gender === 'male' ? 'a man' : 'a woman'}; keep the narrator consistent.`;
}

function partSpec(p: UniquePart): string {
  const rep = (p.repeats > 1 ? `, sung ${p.repeats} times — write it once` : '') + (p.variantOf ? `; a longer/shorter variation of [${p.variantOf}] — reuse its hook lines and fit the target` : '');
  const plan = p.lineTargets.map((n, i) => `${i + 1}) ${n}`).join(', ');
  return `[${p.name}] — ${p.lineTargets.length} lines, syllables per line: ${plan} (total ≈ ${p.target}${rep}). Original for rhythm reference:\n${p.lines.join('\n')}`;
}

export function rewriteMessages(song: Pick<Song, 'language' | 'title' | 'bpm' | 'gender'>, parts: UniquePart[], theme: string, matureDark: boolean, language?: string) {
  const lang = langDef(language || song.language);
  const translated = !!language && language !== song.language;
  const system = [
    'You are an award-winning professional songwriter. You rewrite existing songs on a NEW topic so that the new lyrics can be sung over the ORIGINAL music.',
    `Write ALL sung lines in ${lang.en} only.${lang.code === 'ru' ? ' Use natural, modern, idiomatic Russian with correct word stress that falls naturally on strong beats.' : ''}`,
    '',
    'KEEP THE MUSICAL SKELETON — this matters more than anything else:',
    '- The same sections in the same order, with exactly the section headers given below.',
    '- In every section write EXACTLY the given number of lines, one new line per original phrase, and give each line its syllable count (±1). Count the syllables (vowels) of every line before you write it. Short simple words help to stay within the count.',
    '- Every line is a complete sung phrase. NEVER put one or two words on a separate line and never split a phrase just to reach the line count.',
    ...(translated ? [`- The original is in ${langDef(song.language).en}, but the NEW lyrics must be written in ${lang.en}. Count syllables of the ${lang.en} words.`] : []),
    '- A section that is sung several times (the chorus) is written ONCE; it will be repeated automatically.',
    '',
    'MAKE IT A GOOD SONG:',
    '- Every section rhymes: a clear AABB or ABAB scheme with real end rhymes. No unrhymed lines.',
    '- The chorus is catchy and contains the main hook of the new topic.',
    '- One clear story with logical, consistent details; each line follows from the previous one.',
    narratorRule(song.gender, lang.code),
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
  const user = [
    `NEW TOPIC / what the new lyrics must be about:\n${theme.trim() || 'Free choice — surprise me with an unexpected topic.'}`,
    '',
    `Singer: ${song.gender === 'female' ? 'female' : song.gender === 'male' ? 'male' : 'unknown'}${song.bpm ? ` · tempo ${song.bpm} BPM` : ''}`,
    '',
    'Sections to write, in this order:',
    parts.map(partSpec).join('\n\n'),
    '',
    'Write the new lyrics now. /no_think',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Запрос для одной секции: пропущенной или промахнувшейся по слогам.
 * previous — прошлая попытка: модель видит, сколько слогов в каждой её строке и сколько нужно.
 */
export function partMessages(song: Pick<Song, 'language' | 'title' | 'bpm' | 'gender'>, part: UniquePart, theme: string, matureDark: boolean,
  language: string | undefined, context: string, previous?: string[]) {
  const msgs = rewriteMessages(song, [part], theme, matureDark, language);
  const lang = langDef(language || song.language).en;
  let feedback = '';
  if (previous?.length) {
    const rows = previous.map((l, i) => {
      const n = countSyllables(l);
      const want = part.lineTargets[i];
      const note = want == null ? 'EXTRA line — remove it' : Math.abs(n - want) <= 1 ? 'ok' : n > want ? `too long, needs ${want}` : `too short, needs ${want}`;
      return `${i + 1}) "${l}" — ${n} syllables: ${note}`;
    });
    if (previous.length < part.lineTargets.length) rows.push(`Missing lines: write ${part.lineTargets.length} lines in total.`);
    const total = previous.reduce((a, l) => a + countSyllables(l), 0);
    feedback = `\n\nYour previous version of [${part.name}] has ${total} syllables instead of ≈ ${part.target}:\n${rows.join('\n')}\nRewrite it so every line hits its count. Keep the meaning and the rhymes.`;
  }
  msgs[1] = {
    role: 'user',
    content: `${msgs[1].content.replace(/\nWrite the new lyrics now\. \/no_think$/, '')}\n\nThe rest of the new song is already written (keep the same story and style):\n${context}${feedback}\n\n`
      + `Write ONLY the [${part.name}] section now, in ${lang}: ${part.lineTargets.length} lines with ${part.lineTargets.join(', ')} syllables. Even if the original has names or words in another language, write completely new lines. No title. /no_think`,
  };
  return msgs;
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

/** Строка из одного слова — «огрызок», который модель отрывает ради числа строк: приклеиваем к следующей. */
export function mergeStubLines(lines: string[]): string[] {
  const out: string[] = [];
  let carry = '';
  for (const l of lines) {
    const words = l.trim().split(/\s+/).filter(Boolean);
    if (words.length === 1 && countSyllables(l) <= 3) { carry = carry ? `${carry} ${l.trim()}` : l.trim(); continue; }
    if (carry) {
      const next = /^I\b/.test(l) ? l : l[0].toLocaleLowerCase() + l.slice(1);
      out.push(`${carry.replace(/[.,;:!?…—-]+$/, '')} ${next}`);
      carry = '';
    } else out.push(l);
  }
  if (carry) {
    if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${carry[0].toLocaleLowerCase()}${carry.slice(1)}`;
    else out.push(carry);
  }
  return out;
}

/**
 * Насколько секция не попадает в такт (0 — идеально): промах по сумме слогов
 * плюс средний промах по строкам и штраф за другое число строк.
 */
export function fitScore(lines: string[] | undefined, part: Pick<UniquePart, 'target' | 'lineTargets'>): number {
  if (!lines?.length) return 9;
  const counts = lines.map((l) => countSyllables(l));
  const total = counts.reduce((a, b) => a + b, 0);
  const totalMiss = Math.abs(total - part.target) / Math.max(1, part.target);
  const n = Math.min(counts.length, part.lineTargets.length);
  let lineMiss = 0;
  for (let i = 0; i < n; i++) lineMiss += Math.abs(counts[i] - part.lineTargets[i]) / Math.max(3, part.lineTargets[i]);
  lineMiss = n ? lineMiss / n : 1;
  const countMiss = Math.abs(counts.length - part.lineTargets.length) / Math.max(1, part.lineTargets.length);
  return totalMiss + 0.35 * lineMiss + 0.2 * countMiss;
}

export interface RewriteCheck { part: UniquePart; actual: number; level: 'ok' | 'warn' | 'bad' }

export function checkRewrite(parts: UniquePart[], parsed: ParsedRewrite): RewriteCheck[] {
  return parts.map((p) => {
    const lines = parsed.parts.get(p.key) ?? [];
    const actual = syl(lines);
    return { part: p, actual, level: budgetLevel({ tag: p.tag, start: 0, end: 0, target: p.target, original: 0, actual }) };
  });
}


/** Сборка полного текста по исходной структуре; припев повторяется дословно. */
export function assembleRewrite(sections: SongSection[], parts: UniquePart[], parsed: ParsedRewrite, text?: string): { text: string; missing: string[] } {
  const src = text ? sectionsWithText(sections, text) : sections;
  const { keys } = partKeys(src);
  const missing = new Set<string>();
  let i = 0;
  const blocks = src.map((s) => {
    if (s.kind !== 'vocal') return `[${s.tag}]`;
    const key = keys[i];
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

/**
 * Пол по средней высоте голоса. В пении мужские голоса высоко: рок-тенор держится около C4–D4 (260–300 Гц),
 * поэтому порог выше, чем для речи; ошибку можно поправить в карточке песни.
 */
export function guessGender(f0: number | null | undefined): 'male' | 'female' | null {
  if (!f0) return null;
  return f0 < 285 ? 'male' : 'female';
}
