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
