import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARAMS } from '../src/shared/catalog';
import {
  analyzeLyrics, assembleLyrics, countSyllables, normalizeTag, parseLlmLyrics, planStructure, ruNumber, sanitizeLyrics, timing,
} from '../src/shared/lyrics';
import { buildAceRequest, buildCaption } from '../src/shared/caption';
import type { Settings, TrackParams } from '../src/shared/types';

const P = (o: Partial<TrackParams> = {}): TrackParams => ({ ...DEFAULT_PARAMS, ...o });

test('220 с при 128 BPM: строк ~45, а не 9–25 как в старом проекте', () => {
  const plan = planStructure(P({ duration: 220, bpm: 128 }));
  assert.ok(plan.vocalLines >= 40 && plan.vocalLines <= 56, `vocalLines=${plan.vocalLines}`);
  assert.ok(Math.abs(plan.estimatedSec - 220) < 12, `est=${plan.estimatedSec}`);
  const choruses = plan.sections.filter((s) => s.key === 'C').length;
  assert.ok(choruses >= 2, 'припев повторяется');
  assert.equal(plan.sections[0].tag, 'Intro'); // для 220 с интро есть
  assert.equal(plan.sections.at(-1)!.tag, 'Outro');
});

test('длительности от 30 с до 6 мин дают разумную оценку', () => {
  for (const d of [30, 60, 120, 180, 240, 300, 360]) {
    for (const g of [['Рок'], ['Рэп'], ['Баллада']]) {
      const plan = planStructure(P({ duration: d, genres: g }));
      const tol = d >= 60 ? 0.2 : 0.7; // 30-секундная баллада физически длиннее
      assert.ok(Math.abs(plan.estimatedSec - d) / d < tol, `${g} ${d}s → est ${plan.estimatedSec.toFixed(0)}`);
    }
  }
});

test('рэп плотнее: больше строк', () => {
  const rock = planStructure(P({ duration: 200, genres: ['Рок'] }));
  const rap = planStructure(P({ duration: 200, genres: ['Рэп'] }));
  assert.ok(rap.vocalLines > rock.vocalLines * 1.25, `${rap.vocalLines} vs ${rock.vocalLines}`);
});

test('теги нормализуются', () => {
  assert.equal(normalizeTag('Куплет 2').tag, 'Verse 2');
  assert.equal(normalizeTag('припев').tag, 'Chorus');
  assert.equal(normalizeTag('Bridge - whispered').tag, 'Bridge - whispered');
  assert.equal(normalizeTag("Midnight Run").kind, 'unknown');
  assert.equal(normalizeTag('whispered').kind, 'style');
});

test('очистка: ремарки, скобки, кавычки, цифры, неизвестные теги', () => {
  const src = [
    "[Midnight Run]",
    "Он сказал: 'Держись, мы почти у цели)",
    '(шепот) Ты слышишь город... навсегда?',
    '*звук дождя* Мне 35 лет',
    'Припев:',
    '- «Неоновый город»',
  ].join('\n');
  const r = sanitizeLyrics(src, { allowBacking: false, lang: 'ru' });
  const lines = r.text.split('\n').filter(Boolean);
  assert.equal(lines[0], '[Verse]');
  assert.equal(lines[1], 'Он сказал: Держись, мы почти у цели');
  assert.equal(lines[2], 'Ты слышишь город, навсегда?');
  assert.equal(lines[3], 'Мне тридцать пять лет');
  assert.equal(lines[4], '[Chorus]');
  assert.equal(lines[5], 'Неоновый город');
});

test('бэк-вокал сохраняется, если разрешён', () => {
  const r = sanitizeLyrics('[Chorus]\nНеоновый город не гаси огни (огни)', { allowBacking: true, lang: 'ru' });
  assert.match(r.text, /\(огни\)/);
});

test('длинная строка делится по запятой', () => {
  const r = sanitizeLyrics('[Verse 1]\nОна стоит у окна старого дома, держа в руках письмо и плача навзрыд', { allowBacking: false, lang: 'ru' });
  assert.equal(r.text.split('\n').length, 3);
});

test('числа словами', () => {
  assert.equal(ruNumber(35), 'тридцать пять');
  assert.equal(ruNumber(2026), 'две тысячи двадцать шесть');
  assert.equal(ruNumber(11), 'одиннадцать');
  assert.equal(ruNumber(1000), 'тысяча');
});

test('слоги', () => {
  assert.equal(countSyllables('Неоновый город не гаси огни'), 11);
  assert.ok(countSyllables('We are the champions') >= 5);
});

test('разбор ответа LLM и сборка с повторами', () => {
  const plan = planStructure(P({ duration: 200, bpm: 120 }));
  const raw = '<think>hmm</think>TITLE: Неоновый город\n' + plan.unique
    .map((u) => `[${u.tag}]\n` + Array.from({ length: u.lines }, (_, i) => `${u.tag} строка ${i + 1}`).join('\n'))
    .join('\n\n');
  const parsed = parseLlmLyrics(raw);
  assert.equal(parsed.title, 'Неоновый город');
  const { text, missing } = assembleLyrics(plan, parsed);
  assert.deepEqual(missing, []);
  const chorusCount = (text.match(/\[Chorus\]/g) ?? []).length;
  assert.equal(chorusCount, plan.sections.filter((s) => s.key === 'C').length);
  const a = analyzeLyrics(text, P({ duration: 200, bpm: 120 }));
  assert.equal(a.vocalLines, plan.vocalLines);
  assert.ok(Math.abs(a.estimatedSec - plan.estimatedSec) / plan.estimatedSec < 0.12, `${a.estimatedSec} vs ${plan.estimatedSec}`);
});

test('анализ предупреждает о короткой песне (25 строк на 220 с, как в старом проекте)', () => {
  const text = '[Verse 1]\n' + Array.from({ length: 25 }, () => 'Дождь стучит по крышам до утра').join('\n');
  const a = analyzeLyrics(text, P({ duration: 220, bpm: 128 }));
  assert.equal(a.warnings[0].level, 'bad');
  assert.match(a.warnings[0].message, /Текста мало/);
});

test('caption: пол вокала, без CoT-переписывания, BPM отдельно', () => {
  const p = P({ genres: ['Рок', 'Готик'], voice: 'male', timbre: 'baritone', matureDark: true });
  const cap = buildCaption(p);
  assert.match(cap, /male vocal/);
  assert.match(cap, /warm baritone/);
  assert.match(cap, /gothic rock/);
  assert.match(cap, /dark/);
  const req = buildAceRequest(p, '[Verse 1]\nтест строка', { aceModel: 'm', aceLmModel: 'l', aceInferenceSteps: 8, audioFormat: 'mp3', aceLmTemperature: 0.85 } as Settings);
  assert.equal(req.use_cot_caption, false);
  assert.equal(req.bpm, timing(p).bpm);
  assert.equal(req.vocal_language, 'ru');
});

test('инструментал', () => {
  const p = P({ instrumental: true });
  assert.match(buildCaption(p), /instrumental/);
  assert.doesNotMatch(buildCaption(p), /male vocal/);
  const req = buildAceRequest(p, 'что угодно', { aceModel: 'm', aceLmModel: 'l', aceInferenceSteps: 8, audioFormat: 'mp3', aceLmTemperature: 0.85 } as Settings);
  assert.equal(req.lyrics, '[Instrumental]');
});
