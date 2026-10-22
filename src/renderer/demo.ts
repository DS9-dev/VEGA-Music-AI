/** Демо-режим: имитация бэкенда, когда интерфейс открыт без Electron. */
import type { MusicApi } from '../shared/api';
import { buildCaption } from '../shared/caption';
import { assembleLyrics, parseLlmLyrics, planStructure } from '../shared/lyrics';
import type { JobState, LyricsChunk, Settings, Track, TrackParams, VoiceItem } from '../shared/types';

const SONG: Record<string, string[]> = {
  V1: ['Дождь стучит по крышам до утра', 'Город в неоне не знает сна', 'Фары режут мокрую тьму', 'Я лечу навстречу ему',
    'Светофоры гаснут за спиной', 'Ветер бьёт холодной волной', 'Только бы успеть, пока темно', 'Где-то ждёт меня окно',
    'Улицы сливаются в одну', 'Я ловлю ночную волну', 'Сердце бьётся громче, чем мотор', 'Тянется длинный коридор'],
  P: ['Ближе, ближе к краю ночи', 'Пульс стучит, как метроном', 'Не сверну, не обесточу', 'Свет, горящий за окном'],
  C: ['Неоновый город, не гаси огни', 'Мы с тобой сегодня в нём одни', 'Я лечу сквозь ливень напролёт', 'Пока рассвет меня не найдёт',
    'Неоновый город, не гаси огни', 'Эту ночь навеки сохрани', 'Шины пишут строки на асфальт', 'Мне ни капли этой ночи не жаль'],
  V2: ['Пусто на проспектах, тишина', 'Только отражения в стекле окна', 'Кто-то смотрит вслед из темноты', 'Там, где над рекой горят мосты',
    'Я не помню, сколько городов', 'Пролетел без карты и без слов', 'Но сегодня этот путь иной', 'Кто-то ждёт рассвета вместе со мной',
    'Мокрый воздух пахнет тишиной', 'Город дышит рядом, за спиной', 'Тени пляшут на сырой стене', 'Всё быстрее, всё ясней'],
  B: ['И когда погаснет свет', 'Я оставлю этот след', 'Пусть дорога, как стрела', 'Нас до утра вела',
    'Пусть кончается бензин', 'Я не еду в ночь один', 'Пусть погаснут фонари', 'Ты со мной до зари'],
  V3: ['Небо на востоке посветлело', 'Город засыпает не спеша', 'Я стою у двери, сделав дело', 'И поёт усталая душа',
    'Завтра снова вызов и дорога', 'Завтра снова ливень и неон', 'Мне от этой ночи нужно много', 'Мне от этой ночи нужен он',
    'Солнце поднимается над крышей', 'Тают огоньки в сырой дали', 'Город засыпает, город дышит', 'Мы опять с тобой его прошли'],
};

function demoText(p: TrackParams) {
  const plan = planStructure(p);
  const raw = 'TITLE: Неоновый город\n' + plan.unique.map((u) => `[${u.tag}]\n` +
    Array.from({ length: u.lines }, (_, i) => SONG[u.key][i % SONG[u.key].length]).join('\n')).join('\n\n');
  return { raw, full: assembleLyrics(plan, parseLlmLyrics(raw)).text };
}

function synthWav(seconds = 12): ArrayBuffer {
  const sr = 22050, n = sr * seconds;
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  const notes = [220, 261.6, 329.6, 392, 329.6, 261.6, 196, 246.9];
  for (let i = 0; i < n; i++) {
    const t = i / sr, beat = Math.floor(t * 4), f = notes[beat % notes.length];
    const env = Math.exp(-((t * 4) % 1) * 3);
    const s = (Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 2 * t) * 0.15) * env * (0.6 + 0.4 * Math.sin(t * 0.5));
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s * 0.6)) * 32767, true);
  }
  return buf;
}

export function installDemoApi() {
  const chunkSubs = new Set<(c: LyricsChunk) => void>();
  const jobSubs = new Set<(s: JobState) => void>();
  let job: JobState = { id: '', phase: 'idle', title: '', progress: 0, step: 0, stageLabel: '', detail: '', elapsedSec: 0, etaSec: null };
  let cancelled = false;
  let settings: Settings = {
    aceEndpoint: 'http://127.0.0.1:8001', aceRuntimePath: 'D:\\AI\\ACE-Step-1.5', aceAutoStart: true, aceStopOnExit: true,
    aceModel: 'acestep-v15-turbo', aceLmModel: 'acestep-5Hz-lm-1.7B', aceInferenceSteps: 8, aceLmTemperature: 0.85, audioFormat: 'mp3',
    lmEndpoint: 'http://127.0.0.1:1234', lyricsModel: 'qwen/qwen3-14b', lyricsTemperature: 0.8, unloadLyricsModel: true,
    libraryPath: 'D:\\VEGA-Music-AI\\Library', calibration: { '1': 0.55, '2': 0.72, overhead: 12 },
    seedvcPath: 'D:\\AI\\Seed-VC', separatorPath: 'D:\\AI\\StemSeparator', melbandModelsPath: 'D:\\AI\\StemSeparator\\models',
    transformersCachePath: '', voicesPath: 'D:\\VEGA-Music-AI\\Voices', voiceDiffusionSteps: 30, freeAceForVoice: true,
  };
  const base: TrackParams = {
    theme: 'Ночной курьер мчится сквозь неоновый город под ливнем, чтобы успеть до рассвета', genres: ['Рок', 'Синтвейв'], moods: ['Энергичное'], instrumental: false, matureDark: false,
    voice: 'male', timbre: 'baritone', language: 'ru', duration: 220, bpm: null, key: null, density: 'normal', variants: 2, seedLocked: false, seed: 42, sound: '', allowBacking: false,
    voiceId: null, voiceShift: null,
  };
  const H = 3600e3;
  const tracks: Track[] = [
    { id: 'demo1', title: 'Огни после полуночи', createdAt: new Date(Date.now() - 2 * H).toISOString(), params: base, lyrics: demoText(base).full, caption: buildCaption(base), bpm: 105, variants: [{ file: 'variant-1.mp3', favorite: true }, { file: 'variant-2.mp3' }], generationSeconds: 171 },
    { id: 'demo2', title: 'Сквозь ливень', createdAt: new Date(Date.now() - 26 * H).toISOString(), params: { ...base, genres: ['Поп', 'Синтвейв'], moods: ['Ностальгия', 'Мечтательное'], voice: 'female', timbre: 'breathy', duration: 185 }, lyrics: '', caption: '', bpm: 112, variants: [{ file: 'variant-1.mp3' }, { file: 'variant-2.mp3', favorite: true }], generationSeconds: 132 },
    { id: 'demo3', title: 'Последний маяк', createdAt: new Date(Date.now() - 50 * H).toISOString(), params: { ...base, genres: ['Готик', 'Метал'], moods: ['Мрачное', 'Эпичное'], matureDark: true, timbre: 'deep', duration: 240 }, lyrics: '', caption: '', bpm: 110, variants: [{ file: 'variant-1.mp3' }, { file: 'variant-2.mp3' }], generationSeconds: 188 },
    { id: 'demo4', title: 'Steel Horizon', createdAt: new Date(Date.now() - 75 * H).toISOString(), params: { ...base, genres: ['Оркестр', 'Саундтрек'], instrumental: true, moods: ['Эпичное'], duration: 150 }, lyrics: '[Instrumental]', caption: '', bpm: 95, variants: [{ file: 'variant-1.mp3' }], generationSeconds: 98 },
    { id: 'demo5', title: 'Бит на рассвете', createdAt: new Date(Date.now() - 120 * H).toISOString(), params: { ...base, genres: ['Хип-хоп', 'Лоу-фай'], moods: ['Спокойное'], timbre: 'rap', duration: 200 }, lyrics: '', caption: '', bpm: 90, variants: [{ file: 'variant-1.mp3' }, { file: 'variant-2.mp3' }], generationSeconds: 140 },
  ];

  const D = 86400e3;
  const voices: VoiceItem[] = [
    { id: 'my', name: 'Мой голос', gender: 'male', createdAt: new Date(Date.now() - 3 * D).toISOString(), updatedAt: '', status: 'ready', profile: 'standard',
      sources: [], dataset: { segments: 84, seconds: 372, warnings: [] }, reference: 'reference.wav', f0Median: 146, note: 'D3',
      training: { steps: 800, seconds: 640, finalLoss: 0.18 }, checkpoint: 'model/ft_model.pth', config: 'model/config.yml', consent: true, usable: true },
    { id: 'alice', name: 'Алиса', gender: 'female', createdAt: new Date(Date.now() - 6 * D).toISOString(), updatedAt: '', status: 'ready', profile: 'zero',
      sources: [], dataset: { segments: 22, seconds: 98, warnings: ['Данных немного. Для лучшего сходства добавьте 2–4 песни (желательно 5+ минут вокала).'] },
      reference: 'reference.wav', f0Median: 262, note: 'C4', consent: true, usable: true },
  ];
  tracks.splice(1, 0, { id: 'demoV', title: 'Огни после полуночи · Мой голос', createdAt: new Date(Date.now() - 1.5 * H).toISOString(),
    params: { ...base, voiceId: 'my' }, lyrics: demoText(base).full, caption: buildCaption(base), bpm: 105, voiceName: 'Мой голос',
    variants: [{ file: 'variant-1.mp3', label: 'Вариант 1', favorite: true }, { file: 'variant-2.mp3', label: 'Вариант 2' }, { file: 'variant-1-ace.mp3', label: 'Вариант 1 · ACE', original: true }, { file: 'variant-2-ace.mp3', label: 'Вариант 2 · ACE', original: true }],
    generationSeconds: 236 });

  const emit = (s: Partial<JobState>) => { job = { ...job, ...s }; jobSubs.forEach((f) => f(job)); };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const speed = Number(new URLSearchParams(location.search).get('speed') ?? 1);

  const api: MusicApi = {
    platform: 'win32',
    settings: {
      get: async () => settings,
      set: async (p) => (settings = { ...settings, ...p }),
      reset: async () => settings,
      pickFolder: async () => null,
    },
    status: async () => ({ ace: 'online', aceOwned: true, lm: 'online' }),
    ace: { start: async () => {}, stop: async () => {} },
    lm: { models: async () => [{ key: 'qwen/qwen3-14b', name: 'Qwen3 14B', loaded: true }, { key: 'google/gemma-3-27b', name: 'Gemma 3 27B', loaded: false }] },
    lyrics: {
      generate: async (p) => {
        cancelled = false;
        const { raw, full } = demoText(p);
        chunkSubs.forEach((f) => f({ text: '', thinking: true }));
        await sleep(1500 / speed);
        for (let i = 0; i <= raw.length; i += 6) {
          if (cancelled) throw new Error('aborted');
          chunkSubs.forEach((f) => f({ text: raw.slice(0, i), thinking: false }));
          await sleep(25 / speed);
        }
        return { title: 'Неоновый город', text: full, warnings: [] };
      },
      cancel: async () => { cancelled = true; },
      onChunk: (cb) => { chunkSubs.add(cb); return () => chunkSubs.delete(cb); },
    },
    job: {
      start: async (p, title) => {
        cancelled = false;
        const withVoice = !!p.voiceId && !p.instrumental;
        const vname = voices.find((v) => v.id === p.voiceId)?.name;
        job = { id: 'demo', kind: 'track', steps: withVoice ? ['Подготовка', 'Композиция', 'Синтез', 'Голос', 'Сохранение'] : undefined, phase: 'preparing', title, progress: 0.01, step: 0, stageLabel: 'Подготовка', detail: 'Освобождаем видеопамять…', elapsedSec: 0, etaSec: null };
        emit({});
        void (async () => {
          const total = 30 / speed;
          await sleep(1500 / speed);
          for (let t = 0; t <= total; t += 0.5) {
            if (cancelled) { emit({ phase: 'cancelled', stageLabel: 'Отменено' }); return; }
            const g = t / total;
            if (withVoice && g > 0.65) {
              emit({ phase: 'generating', step: 3, stageLabel: 'Голос', detail: g < 0.75 ? 'Отделяем вокал от музыки · вариант 1 из 2' : 'Перепеваем вокал выбранным голосом · вариант 1 из 2', progress: 0.04 + 0.92 * g, elapsedSec: t * speed, etaSec: Math.round((total - t) * speed) });
            } else emit({ phase: 'generating', step: g < 0.42 ? 1 : 2, stageLabel: g < 0.42 ? 'Композиция' : g > 0.9 ? 'Финальная обработка' : 'Синтез звука',
              detail: g < 0.42 ? 'Сочиняем мелодию и аранжировку' : 'Синтезируем инструменты и вокал', progress: 0.04 + 0.92 * g, elapsedSec: t * speed, etaSec: Math.round((total - t) * speed) });
            await sleep(500);
          }
          emit({ phase: 'saving', step: withVoice ? 4 : 3, stageLabel: 'Сохранение', detail: 'Сохраняем трек…', progress: 0.98 });
          await sleep(800);
          const t: Track = { id: 'demo' + Date.now(), title, createdAt: new Date().toISOString(), params: p, lyrics: p.instrumental ? '[Instrumental]' : demoText(p).full, caption: buildCaption(p), bpm: 120, variants: Array.from({ length: p.variants }, (_, i) => ({ file: `variant-${i + 1}.wav`, label: `Вариант ${i + 1}` })), generationSeconds: 32, voiceName: withVoice ? vname : undefined };
          if (withVoice) t.variants.push(...t.variants.map((v, i) => ({ file: `variant-${i + 1}-ace.wav`, label: `Вариант ${i + 1} · ACE`, original: true })));
          tracks.unshift(t);
          emit({ phase: 'done', step: withVoice ? 4 : 3, stageLabel: 'Готово', progress: 1, trackId: t.id, etaSec: null, elapsedSec: 32 });
        })();
        return 'demo';
      },
      cancel: async () => { cancelled = true; },
      reset: async () => { job = { ...job, phase: 'idle', progress: 0 }; },
      get: async () => job,
      onUpdate: (cb) => { jobSubs.add(cb); return () => jobSubs.delete(cb); },
    },
    library: {
      list: async () => tracks,
      readAudio: async () => synthWav(),
      update: async (id, patch) => { const i = tracks.findIndex((t) => t.id === id); tracks[i] = { ...tracks[i], ...patch }; return tracks[i]; },
      remove: async (id) => { const i = tracks.findIndex((t) => t.id === id); if (i >= 0) tracks.splice(i, 1); },
      reveal: async () => {},
      openRoot: async () => {},
    },
    voices: {
      list: async () => voices.map((v) => ({ ...v })),
      pickSources: async () => ['D:\\Music\\Моя песня 1.mp3', 'D:\\Music\\Моя песня 2.mp3', 'D:\\Music\\Акапелла.wav'],
      create: async (spec) => {
        const id = 'v' + Date.now();
        voices.unshift({ id, name: spec.name, gender: spec.gender, createdAt: new Date().toISOString(), updatedAt: '', status: 'preparing', profile: spec.profile, sources: [], consent: true, usable: false });
        runVoiceJob(id, spec.name, spec.profile !== 'zero');
        return id;
      },
      retrain: async (id) => { const v = voices.find((x) => x.id === id)!; v.status = 'training'; runVoiceJob(id, v.name, true, true); },
      rename: async (id, name) => { const v = voices.find((x) => x.id === id)!; v.name = name; return v; },
      remove: async (id) => { const i = voices.findIndex((x) => x.id === id); if (i >= 0) voices.splice(i, 1); },
      reveal: async () => {},
      readAudio: async () => synthWav(),
      exportVoice: async (id) => `D:\\${voices.find((x) => x.id === id)?.name}.vegavoice`,
      importVoice: async () => null,
      check: async () => ({ ok: true, problems: [], cuda: true, python: '3.10.11' }),
      revoice: async (trackId, variant, voiceId) => {
        const t = tracks.find((x) => x.id === trackId)!;
        const v = voices.find((x) => x.id === voiceId)!;
        const title = `${t.title} · ${v.name}`;
        void simulate('revoice', title, ['Разделение', 'Голос', 'Сведение'], [[0, 'Разделение', 'Отделяем вокал от музыки'], [1, 'Голос', 'Перепеваем вокал выбранным голосом'], [2, 'Сведение', 'Сводим вокал с музыкой']], 12, () => {
          const nt: Track = { ...t, id: 'rv' + Date.now(), title, createdAt: new Date().toISOString(), voiceName: v.name, variants: [{ file: 'variant-1.mp3', label: v.name }] };
          tracks.unshift(nt);
          return { trackId: nt.id, detail: 'Трек сохранён в библиотеку' };
        });
        void variant;
        return 'demo';
      },
      openRoot: async () => {},
    },
    win: { minimize() {}, maximize() {}, close() {} },
  };

  async function simulate(kind: JobState['kind'], title: string, steps: string[], stages: [number, string, string][], seconds: number,
    finish: () => Partial<JobState>, targetId?: string, onStage?: (i: number) => void) {
    cancelled = false;
    job = { id: 'demo-' + kind, kind, steps, targetId, phase: 'preparing', title, progress: 0.01, step: 0, stageLabel: steps[0], detail: 'Освобождаем видеопамять…', elapsedSec: 0, etaSec: null };
    emit({});
    const total = seconds / speed;
    await sleep(800 / speed);
    for (let t = 0; t <= total; t += 0.5) {
      if (cancelled) { emit({ phase: 'cancelled', stageLabel: 'Отменено' }); return; }
      const g = t / total;
      const si = Math.min(stages.length - 1, Math.floor(g * stages.length));
      const [step, label, detail] = stages[si];
      onStage?.(si);
      const extra = kind === 'voice' && label === 'Обучение' ? ` · Шаг ${Math.round(((g * stages.length - si)) * 800)} из 800 · ошибка ${(0.6 - g * 0.4).toFixed(3)}` : '';
      emit({ phase: 'generating', step, stageLabel: label, detail: detail + extra, progress: 0.03 + 0.94 * g, elapsedSec: t * speed, etaSec: Math.round((total - t) * speed) });
      await sleep(500);
    }
    emit({ phase: 'done', step: steps.length - 1, stageLabel: 'Готово', progress: 1, etaSec: null, ...finish() });
  }

  function runVoiceJob(id: string, name: string, train: boolean, retrainOnly = false) {
    const steps = train ? ['Вокал', 'Нарезка', 'Обучение', 'Готово'] : ['Вокал', 'Нарезка', 'Готово'];
    const stages: [number, string, string][] = retrainOnly ? [[2, 'Обучение', 'Обучаем модель голоса']]
      : [[0, 'Выделение вокала', 'Выделяем вокал: Моя песня 1.mp3'], [0, 'Выделение вокала', 'Выделяем вокал: Моя песня 2.mp3'], [1, 'Нарезка фраз', 'Нарезаем фразы'],
        ...(train ? [[2, 'Обучение', 'Обучаем модель голоса'], [2, 'Обучение', 'Обучаем модель голоса'], [2, 'Обучение', 'Обучаем модель голоса']] as [number, string, string][] : [])];
    void simulate('voice', name, steps, stages, train ? 36 : 14, () => {
      const v = voices.find((x) => x.id === id)!;
      Object.assign(v, { status: 'ready', usable: true, reference: 'reference.wav', f0Median: 150, note: 'D3', dataset: { segments: 61, seconds: 284, warnings: [] },
        ...(train ? { checkpoint: 'model/ft_model.pth', config: 'model/config.yml', training: { steps: 800, seconds: 610, finalLoss: 0.21 } } : {}) });
      return { detail: `284 с вокала · 61 фраза${train ? ' · 800 шагов обучения' : ''}` };
    }, id, (i) => {
      const v = voices.find((x) => x.id === id);
      if (v && train && stages[i][0] === 2) v.status = 'training';
    });
  }
  (window as unknown as { api: MusicApi }).api = api;
}
