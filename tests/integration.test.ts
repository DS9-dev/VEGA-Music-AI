/** Интеграция main-процесса против имитаций ACE-Step и LM Studio (без Electron). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AceClient } from '../electron/ace';
import { LmStudio } from '../electron/lmstudio';
import { Library } from '../electron/library';
import { Generator, generateLyrics } from '../electron/generation';
import { defaultSettings } from '../electron/settings';
import { DEFAULT_PARAMS } from '../src/shared/catalog';
import { planStructure } from '../src/shared/lyrics';
import type { JobState, Settings } from '../src/shared/types';

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  return new Promise((res) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${(server.address() as any).port}`, server }));
  });
}
const body = (req: any) => new Promise<any>((r) => { let b = ''; req.on('data', (c: any) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });

test('ACE: отправка, прогресс, скачивание вариантов, запись в библиотеку', async () => {
  let polls = 0;
  let received: any = null;
  const ace = await listen(async (req, res) => {
    const send = (data: any) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data, code: 200, error: null })); };
    if (req.url === '/health') return send({ status: 'ok', models_initialized: true });
    if (req.url === '/release_task') { received = await body(req); return send({ task_id: 't1', status: 'queued' }); }
    if (req.url === '/query_result') {
      await body(req); polls++;
      if (polls < 3) return send([{ task_id: 't1', status: 0, result: JSON.stringify([{ progress: polls * 0.3, stage: 'lm' }]), progress_text: '' }]);
      return send([{ task_id: 't1', status: 1, result: JSON.stringify([{ file: '/v1/audio?path=%2Ftmp%2Fa.mp3' }, { file: '/v1/audio?path=%2Ftmp%2Fb.mp3' }]) }]);
    }
    if (req.url?.startsWith('/v1/audio')) { res.end(Buffer.from('ID3fake-mp3')); return; }
    res.statusCode = 404; res.end();
  });
  const root = mkdtempSync(join(tmpdir(), 'mb-'));
  const s: Settings = { ...defaultSettings(root), aceEndpoint: ace.url, libraryPath: join(root, 'Library'), calibration: { '1': 0.01, '2': 0.01, overhead: 1 } };
  const states: JobState[] = [];
  let calib = 0;
  const gen = new Generator({
    ace: new AceClient(() => s.aceEndpoint), library: new Library(() => s.libraryPath), settings: () => s,
    ensureAce: async () => {}, unloadLlm: async () => {}, saveCalibration: (_v, x) => { calib = x; }, onUpdate: (st) => states.push(st),
  });
  const p = { ...DEFAULT_PARAMS, duration: 60, genres: ['Рок'], voice: 'female' as const, timbre: 'alto' };
  gen.start(p, 'Тест', '[Куплет 1]\n(шёпот) Я иду по городу 5 раз\n[Припев]\nЛа-ла-ла под небом');
  for (let i = 0; i < 100 && !['done', 'error'].includes(gen.state.phase); i++) await new Promise((r) => setTimeout(r, 100));
  ace.server.close();
  assert.equal(gen.state.phase, 'done', gen.state.error ?? '');
  // запрос в ACE
  assert.equal(received.use_cot_caption, false);
  assert.match(received.prompt, /female vocal/);
  assert.match(received.lyrics, /\[Verse 1\]\nЯ иду по городу пять раз\n\n\[Chorus\]/);
  assert.equal(received.batch_size, 2);
  // прогресс монотонный
  for (let i = 1; i < states.length; i++) assert.ok(states[i].progress >= states[i - 1].progress);
  assert.ok(states.some((x) => x.phase === 'generating' && x.step === 1));
  // библиотека
  const lib = new Library(() => s.libraryPath).list();
  assert.equal(lib.length, 1);
  assert.equal(lib[0].variants.length, 2);
  assert.ok(existsSync(join(s.libraryPath, lib[0].id, 'variant-1.mp3')));
  assert.equal(readFileSync(join(s.libraryPath, lib[0].id, 'variant-2.mp3'), 'utf8'), 'ID3fake-mp3');
  assert.ok(calib > 0);
});

test('ACE: ошибка генерации доходит до пользователя', async () => {
  const ace = await listen(async (req, res) => {
    const send = (data: any) => res.end(JSON.stringify({ data, code: 200 }));
    if (req.url === '/release_task') { await body(req); return send({ task_id: 'x' }); }
    if (req.url === '/query_result') { await body(req); return send([{ task_id: 'x', status: 2, result: JSON.stringify([{ error: 'CUDA out of memory' }]) }]); }
    res.statusCode = 404; res.end();
  });
  const root = mkdtempSync(join(tmpdir(), 'mb-'));
  const s: Settings = { ...defaultSettings(root), aceEndpoint: ace.url, libraryPath: join(root, 'L') };
  const gen = new Generator({ ace: new AceClient(() => s.aceEndpoint), library: new Library(() => s.libraryPath), settings: () => s,
    ensureAce: async () => {}, unloadLlm: async () => {}, saveCalibration: () => {}, onUpdate: () => {} });
  gen.start({ ...DEFAULT_PARAMS, instrumental: true }, 'X', '');
  for (let i = 0; i < 50 && gen.state.phase !== 'error'; i++) await new Promise((r) => setTimeout(r, 100));
  ace.server.close();
  assert.equal(gen.state.phase, 'error');
  assert.match(gen.state.error!, /CUDA out of memory/);
});

test('LM Studio: поток с <think>, сборка песни с повторами, выгрузка модели', async () => {
  const p = { ...DEFAULT_PARAMS, duration: 200, genres: ['Поп'] };
  const plan = planStructure(p);
  const answer = '<think>план песни...</think>TITLE: Ночной город\n' + plan.unique.map((u) =>
    `[${u.tag}]\n` + Array.from({ length: u.lines }, (_, i) => `Строка ${u.tag} номер ${['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать'][i]}`).join('\n')).join('\n\n');
  let unloaded = '';
  let chatBody: any = null;
  const lm = await listen(async (req, res) => {
    if (req.url === '/v1/chat/completions') {
      chatBody = await body(req);
      res.setHeader('Content-Type', 'text/event-stream');
      for (let i = 0; i < answer.length; i += 17) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(i, i + 17) } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    if (req.url === '/api/v1/models' && req.method === 'GET') { res.end(JSON.stringify({ models: [{ type: 'llm', key: 'qwen/qwen3-14b', display_name: 'Qwen3 14B', loaded_instances: [{ id: 'qwen/qwen3-14b' }] }] })); return; }
    if (req.url === '/api/v1/models/unload') { unloaded = (await body(req)).instance_id; res.end('{}'); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'qwen/qwen3-14b' }] })); return; }
    res.statusCode = 404; res.end();
  });
  const s = { ...defaultSettings('/tmp'), lmEndpoint: lm.url + '/v1' };
  const client = new LmStudio(() => s.lmEndpoint);
  const chunks: { text: string; thinking: boolean }[] = [];
  const r = await generateLyrics(client, s, p, (c) => chunks.push(c), new AbortController().signal);
  assert.equal(r.title, 'Ночной город');
  assert.ok(chunks[0].thinking, 'сначала модель «думает»');
  assert.ok(!chunks.at(-1)!.text.includes('<think>'));
  assert.match(chatBody.messages[1].content, /no_think/);
  const choruses = (r.text.match(/\[Chorus\]/g) ?? []).length;
  assert.equal(choruses, plan.sections.filter((x) => x.key === 'C').length);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual((await client.listModels()).map((m) => m.loaded), [true]);
  assert.ok(await client.unload('qwen/qwen3-14b'));
  assert.equal(unloaded, 'qwen/qwen3-14b');
  lm.server.close();
});
