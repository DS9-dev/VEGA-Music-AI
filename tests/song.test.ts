import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS } from '../src/shared/catalog';
import {
  applyCleanup, applyRestructure, assembleRewrite, buildLines, buildSections, checkRewrite, lineSimilarity, measureBudgets, parseRewrite,
  guessGender, rewriteMessages, sectionBudgets, sectionsToLyrics, sectionsWithText, songTrackParams, uniqueParts, vocalSpan,
} from '../src/shared/song';
import type { Song, SongWord } from '../src/shared/types';

/** Синтетическая «распознанная» песня: строки по 4 с, паузы между блоками. */
function fakeWords(blocks: { at: number; lines: string[] }[]): SongWord[] {
  const words: SongWord[] = [];
  for (const b of blocks) {
    b.lines.forEach((line, li) => {
      const start = b.at + li * 4;
      const ws = line.split(' ');
      ws.forEach((w, wi) => {
        const s = start + (wi * 3.2) / ws.length;
        words.push({ w, s, e: s + 3.0 / ws.length });
      });
    });
  }
  return words;
}

const V1 = ['Город спит под тёплым дождём', 'Фонари горят за окном', 'Я иду по мокрой мостовой', 'Ветер шепчет мне домой'];
const CH = ['Ночь моя неоновая ночь', 'Унеси печали прочь', 'Ночь моя неоновая ночь', 'Никому не превозмочь'];
const V2 = ['Утро где-то там вдали', 'Тают в лужах корабли', 'Шум машин и стук сердец', 'Это вовсе не конец'];
const BR = ['Тишина и только свет', 'Только свет и больше нет'];

function song(): { words: SongWord[]; duration: number } {
  return {
    words: fakeWords([
      { at: 12, lines: V1 },
      { at: 32, lines: CH },
      { at: 52, lines: V2 },
      { at: 72, lines: CH.map((l, i) => (i === 3 ? 'Никому не превозмочь бы' : l)) }, // распознано чуть иначе
      { at: 100, lines: BR },
      { at: 112, lines: CH },
    ]),
    duration: 140,
  };
}

test('слова → строки: по паузам, с заглавной буквы', () => {
  const { words } = song();
  const lines = buildLines(words, 120);
  assert.equal(lines.length, 22);
  assert.equal(lines[0].text, 'Город спит под тёплым дождём');
  assert.ok(lines[0].start >= 12 && lines[0].end <= 16);
});

test('галлюцинации Whisper отбрасываются', () => {
  const lines = buildLines([{ w: 'Продолжение', s: 1, e: 1.5 }, { w: 'следует...', s: 1.5, e: 2 }, { w: 'Привет', s: 10, e: 10.5 }], 120);
  assert.deepEqual(lines.map((l) => l.text), ['Привет']);
});

test('секции: интро, куплеты, повторяющийся припев, бридж, проигрыш, аутро', () => {
  const { words, duration } = song();
  const sections = buildSections(buildLines(words, 120), duration, 120);
  const tags = sections.map((s) => s.tag);
  assert.deepEqual(tags, ['Intro', 'Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Instrumental', 'Bridge', 'Chorus', 'Outro']);
  const ch = sections.filter((s) => s.tag === 'Chorus');
  assert.ok(ch.every((c) => c.group && c.group === ch[0].group), 'припевы в одной группе');
  const text = sectionsToLyrics(sections);
  assert.match(text, /^\[Intro\]\n\n\[Verse 1\]\nГород спит/);
});

test('похожесть строк устойчива к мелким ошибкам распознавания', () => {
  assert.ok(lineSimilarity('Ночь моя неоновая ночь', 'ночь моя неоновая ночь!') === 1);
  assert.ok(lineSimilarity('Никому не превозмочь', 'Никому не превозмочь бы') > 0.8);
  assert.ok(lineSimilarity('Город спит под дождём', 'Утро где-то там вдали') < 0.3);
});

test('исправление моделью: строки заменяются только при совпадении числа строк, теги перенумеровываются', () => {
  const { words, duration } = song();
  const sections = buildSections(buildLines(words, 120), duration, 120);
  const answer = [
    '#1 [Verse]', ...V1.map((l) => l.replace('дождём', 'дождем')),
    '#2 [Chorus]', ...CH,
    '#3 [Verse]', 'всего одна строка',
    '#4 [Chorus]', ...CH,
    '#5 [Bridge]', ...BR,
    '#6 [Chorus]', ...CH,
  ].join('\n');
  const r = applyCleanup(sections, `<think>хм</think>${answer}`);
  assert.equal(r.fixedBlocks, 5);
  const voc = r.sections.filter((s) => s.kind === 'vocal');
  assert.equal(voc[0].lines[0].text, 'Город спит под тёплым дождем');
  assert.equal(voc[2].lines.length, 4, 'блок с другим числом строк не тронут');
  assert.deepEqual(voc.map((s) => s.tag), ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Chorus']);
  assert.equal(voc[3].lines[3].text, 'Никому не превозмочь');
});

test('бюджет слогов: по оригиналу секции, пропуски распознавания добираются по плотности', () => {
  const { words, duration } = song();
  const sections = buildSections(buildLines(words, 120), duration, 120);
  const b = sectionBudgets(sections);
  assert.equal(b.length, 6);
  assert.equal(b[0].target, b[0].original);
  assert.ok(b[0].target >= 28 && b[0].target <= 36, `target=${b[0].target}`);
  // если секция распознана почти пустой — целевой бюджет по средней плотности
  const sparse = sections.map((s) => (s.tag === 'Verse 2' ? { ...s, lines: [s.lines[0]] } : s));
  const b2 = sectionBudgets(sparse);
  assert.ok(b2[2].target > b2[2].original * 2);
});

test('переписывание: уникальные части, разбор ответа, проверка бюджета и сборка с повтором припева', () => {
  const { words, duration } = song();
  const sections = buildSections(buildLines(words, 120), duration, 120);
  const parts = uniqueParts(sections);
  assert.deepEqual(parts.map((p) => p.name), ['Verse 1', 'Chorus', 'Verse 2', 'Bridge']);
  assert.equal(parts[1].repeats, 3);
  const raw = [
    'TITLE: Северный ветер',
    '[Verse 1]', 'Снег ложится на поля', 'Тихо дремлет вся земля', 'Я шагаю в белый день', 'За спиной плывёт метель',
    '[Chorus] — hook', 'Ветер мой холодный ветер', 'Самый лучший он на свете', 'Ветер мой холодный ветер', 'Нас найдёт и на рассвете',
    'Verse 2:', 'Лёд звенит на реке', 'Огонёк вдалеке', 'Дом стоит на горе', 'Свет в узорном окне',
  ].join('\n');
  const parsed = parseRewrite(raw, parts);
  assert.equal(parsed.title, 'Северный ветер');
  assert.equal(parsed.parts.size, 3);
  const checks = checkRewrite(parts, parsed);
  assert.equal(checks.find((c) => c.part.name === 'Bridge')!.actual, 0);
  assert.equal(checks.find((c) => c.part.name === 'Bridge')!.level, 'bad');
  const out = assembleRewrite(sections, parts, parsed);
  assert.deepEqual(out.missing, ['Bridge']);
  assert.equal(out.text.match(/Ветер мой холодный ветер/g)!.length, 6, 'припев трижды, по 2 раза в каждом');
  assert.match(out.text, /\[Instrumental\]/);
  const m = measureBudgets(sectionBudgets(sections), out.text);
  assert.ok(m[0].actual! > 20);
});

test('правки текста переносятся на секции с таймингом', () => {
  const { words, duration } = song();
  const sections = buildSections(buildLines(words, 120), duration, 120);
  const edited = sectionsToLyrics(sections).replace('Город спит под тёплым дождём', 'Город спит под летним дождём');
  const s2 = sectionsWithText(sections, edited);
  assert.equal(s2[1].lines[0].text, 'Город спит под летним дождём');
  assert.equal(s2[1].lines[0].start, sections[1].lines[0].start);
});

test('песня → параметры трека и участок перепевки', () => {
  const { words, duration } = song();
  const sections = buildSections(buildLines(words, 120), duration, 120);
  const s: Song = {
    id: 'x', title: 'T', createdAt: '', status: 'ready', sourceName: 'a.mp3', source: 'source.mp3', duration: 141.3, bpm: 119.6, key: 'A minor',
    gender: 'female', language: 'ru', sections, lyrics: '', warnings: [],
  };
  const p = songTrackParams(s, DEFAULT_PARAMS);
  assert.equal(p.duration, 140);
  assert.equal(p.bpm, 120);
  assert.equal(p.key, 'A minor');
  assert.equal(p.voice, 'female');
  assert.equal(p.sourceSongId, 'x');
  const span = vocalSpan(s);
  assert.ok(span.start > 11 && span.start < 12);
  assert.ok(span.end > 127 && span.end <= 141.3);
});

test('куплет без паузы переходит в припев — блок разрезается по повторяющимся строкам', () => {
  const words = fakeWords([
    { at: 10, lines: [...V1, ...CH] }, // ни одной паузы между куплетом и припевом
    { at: 50, lines: [...V2, ...CH] },
    { at: 92, lines: CH },
  ]);
  const sections = buildSections(buildLines(words, 118), 120, 118);
  const voc = sections.filter((s) => s.kind === 'vocal');
  assert.deepEqual(voc.map((s) => s.tag), ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Chorus']);
  assert.equal(voc[0].lines.length, 4);
  assert.equal(voc[1].lines[0].text, CH[0]);
});

/** Слова подряд без пауз (быстрый рок): 0.3 с на слово, пауза только между блоками. */
function continuous(text: string, at: number): SongWord[] {
  return text.split(' ').map((w, i) => ({ w, s: at + i * 0.3, e: at + i * 0.3 + 0.28 }));
}

test('нарезка без пауз: по точкам Whisper, лучшее место разреза, союз переносится в следующую строку', () => {
  const words = continuous('Is anyone awake tonight in this electric town? Turn the radio up and let the windows down. We keep the engine running because we got the night to burn', 2);
  const lines = buildLines(words, 120).map((l) => l.text);
  assert.deepEqual(lines, [
    'Is anyone awake tonight in this electric town?',
    'Turn the radio up and let the windows down',
    'We keep the engine running',
    'Because we got the night to burn',
  ]);
});

test('одиночное «Bye» на тишине в конце — галлюцинация', () => {
  const words = [...continuous('We ride until the morning light', 1), { w: 'Bye.', s: 30, e: 30.4 }];
  assert.deepEqual(buildLines(words, 120).map((l) => l.text), ['We ride until the morning light']);
});

test('перестройка моделью: новые строки и секции, время — по словам Whisper', () => {
  const words = [
    ...continuous('We ride until the morning light the city never sleeps tonight. Hey hey', 10),
    ...continuous('Burn it up burn it down we are the loudest in the town', 30),
    ...continuous('Burn it up burn it down we are the loudest in the town', 60),
  ];
  const raw = [
    '[Verse]', 'We ride until the morning light', 'The city never sleeps tonight',
    '[Chorus]', 'Burn it up, burn it down', "We're the loudest in the town",
    '[Chorus]', 'Burn it up, burn it down', "We're the loudest in the town",
  ].join('\n');
  const s = applyRestructure(words, raw, 80, 120)!;
  assert.ok(s);
  const voc = s.filter((x) => x.kind === 'vocal');
  assert.deepEqual(voc.map((x) => x.tag), ['Verse 1', 'Chorus', 'Chorus']);
  assert.equal(voc[0].lines[1].text, 'The city never sleeps tonight');
  assert.ok(Math.abs(voc[0].lines[1].start - (10 + 6 * 0.3)) < 0.01, `start=${voc[0].lines[1].start}`);
  assert.ok(Math.abs(voc[2].start - 60) < 0.01);
  assert.equal(voc[1].group, voc[2].group);
  assert.deepEqual(s.map((x) => x.tag), ['Intro', 'Verse 1', 'Instrumental', 'Chorus', 'Instrumental', 'Chorus', 'Outro']);
  // ответ «не про эту песню» — не принимается
  assert.equal(applyRestructure(words, '[Verse]\nСовсем другой текст\nНичего общего', 80, 120), null);
});

test('пол по высоте голоса: высокий рок-тенор — мужской', () => {
  assert.equal(guessGender(262), 'male'); // C4
  assert.equal(guessGender(150), 'male');
  assert.equal(guessGender(350), 'female');
  assert.equal(guessGender(null), null);
});

test('новый текст на другом языке: модель получает язык перевода', () => {
  const sections = buildSections(buildLines(fakeWords([{ at: 5, lines: V1 }, { at: 25, lines: CH }]), 120), 50, 120);
  const parts = uniqueParts(sections);
  const song = { language: 'en', title: 'T', bpm: 120, gender: 'male' as const };
  const ru = rewriteMessages(song, parts, 'тема', false, 'ru');
  assert.match(ru[0].content, /Write ALL sung lines in Russian only/);
  assert.match(ru[0].content, /original is in English, but the NEW lyrics must be written in Russian/);
  const same = rewriteMessages(song, parts, 'тема', false);
  assert.match(same[0].content, /in English only/);
  assert.doesNotMatch(same[0].content, /must be written in/);
});

test('расширенный последний припев — отдельный вариант со своим бюджетом', () => {
  const longCh = [...CH, 'Ночь моя неоновая ночь опять', 'Унеси печали прочь сейчас', 'Ночь моя неоновая ночь'];
  const sections = buildSections(buildLines(fakeWords([
    { at: 10, lines: V1 }, { at: 30, lines: CH }, { at: 50, lines: V2 }, { at: 70, lines: CH }, { at: 96, lines: longCh },
  ]), 120), 140, 120);
  const voc = sections.filter((s) => s.kind === 'vocal');
  assert.deepEqual(voc.map((s) => s.tag), ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Chorus']);
  const parts = uniqueParts(sections);
  assert.deepEqual(parts.map((p) => p.name), ['Verse 1', 'Chorus', 'Verse 2', 'Chorus 2']);
  const main = parts.find((p) => p.name === 'Chorus')!, variant = parts.find((p) => p.name === 'Chorus 2')!;
  assert.equal(main.repeats, 2);
  assert.equal(variant.variantOf, 'Chorus');
  assert.ok(variant.target > main.target * 1.4);
  const raw = '[Verse 1]\nа\n[Chorus]\nкороткий припев\n[Verse 2]\nб\n[Chorus 2]\nдлинный вариант припева';
  const out = assembleRewrite(sections, parts, parseRewrite(raw, parts)).text;
  assert.equal(out.match(/короткий припев/g)!.length, 2);
  assert.equal(out.match(/длинный вариант припева/g)!.length, 1);
});
