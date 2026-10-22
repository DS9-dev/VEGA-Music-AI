import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Settings } from '../src/shared/types';

/** Ищем установленный ACE-Step рядом с проектом или в типичных местах. */
export function findAceRuntime(appRoot: string): string {
  const parent = dirname(appRoot);
  const candidates = [
    join(appRoot, 'ACE-Step-1.5'),
    join(parent, 'ACE-Step-1.5'),
    join(parent, 'VEGA_Music', 'ACE-Step-1.5'),
    'T:\\VEGA_Music\\ACE-Step-1.5',
    'C:\\ACE-Step-1.5',
    'D:\\ACE-Step-1.5',
  ];
  return candidates.find((c) => existsSync(join(c, 'pyproject.toml'))) ?? join(parent, 'ACE-Step-1.5');
}

/** Первый существующий путь из списка (проверяется маркер внутри папки). */
function firstExisting(cands: string[], marker: string, fallback: string): string {
  return cands.find((c) => existsSync(marker ? join(c, marker) : c)) ?? fallback;
}

/** Компоненты голосовых моделей: Seed-VC, MelBand-RoFormer и их модели. */
export function findVoiceTools(appRoot: string) {
  const parent = dirname(appRoot);
  const roots = [appRoot, parent, join(parent, 'VEGA_Music'), 'T:\\VEGA_Music', 'D:\\AI', 'C:\\AI'];
  const exe = process.platform === 'win32' ? join('.venv', 'Scripts', 'melband-roformer-infer.exe') : join('.venv', 'bin', 'melband-roformer-infer');
  return {
    seedvcPath: firstExisting(roots.flatMap((r) => [join(r, 'Seed-VC'), join(r, 'seed-vc')]), 'inference.py', join(parent, 'Seed-VC')),
    separatorPath: firstExisting(roots.map((r) => join(r, 'StemSeparator')), exe, join(parent, 'StemSeparator')),
    melbandModelsPath: firstExisting(roots.flatMap((r) => [join(r, 'Models', 'StemSeparation', 'MelBand-RoFormer'), join(r, 'StemSeparator', 'models')]), '', join(parent, 'StemSeparator', 'models')),
    transformersCachePath: firstExisting(roots.map((r) => join(r, 'Models', 'Voice', 'Seed-VC', 'hf', 'transformers')), '', ''),
  };
}

export function defaultSettings(appRoot: string): Settings {
  return {
    aceEndpoint: 'http://127.0.0.1:8001',
    aceRuntimePath: findAceRuntime(appRoot),
    aceAutoStart: true,
    aceStopOnExit: true,
    aceModel: 'acestep-v15-turbo',
    aceLmModel: 'acestep-5Hz-lm-1.7B',
    aceInferenceSteps: 8,
    aceLmTemperature: 0.85,
    audioFormat: 'mp3',
    lmEndpoint: 'http://127.0.0.1:1234',
    lyricsModel: 'qwen/qwen3-14b',
    lyricsTemperature: 0.8,
    unloadLyricsModel: true,
    libraryPath: join(appRoot, 'Library'),
    // по реальному прогону VEGA: 220 с аудио, 2 варианта ≈ 168 с
    calibration: { '1': 0.55, '2': 0.72, overhead: 12 },
    ...findVoiceTools(appRoot),
    voicesPath: join(appRoot, 'Voices'),
    voiceDiffusionSteps: 30,
    freeAceForVoice: true,
  };
}

export class SettingsStore {
  private value: Settings;
  constructor(private file: string, private defaults: Settings) {
    this.value = { ...defaults };
    try {
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        this.value = { ...defaults, ...saved, calibration: { ...defaults.calibration, ...(saved.calibration ?? {}) } };
      }
    } catch { /* повреждённый файл — используем значения по умолчанию */ }
  }
  get(): Settings { return structuredClone(this.value); }
  set(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.value, null, 2), 'utf8');
    return this.get();
  }
  reset(): Settings { return this.set(this.defaults); }
}
