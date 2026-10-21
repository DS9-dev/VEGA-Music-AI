export type VoiceGender = 'male' | 'female';
export type Density = 'airy' | 'normal' | 'dense';

/** Всё, что пользователь задаёт в форме создания трека. */
export interface TrackParams {
  theme: string;
  genres: string[];
  moods: string[];
  instrumental: boolean;
  matureDark: boolean;
  voice: VoiceGender;
  timbre: string;
  language: string; // код: ru, en, ...
  duration: number; // секунды
  bpm: number | null; // null = авто по жанру
  key: string | null; // null = авто
  density: Density;
  variants: 1 | 2;
  seedLocked: boolean;
  seed: number;
  sound: string; // доп. описание звучания/инструментов (англ. лучше)
  allowBacking: boolean; // разрешить бэк-вокал в (скобках)
}

export interface Settings {
  aceEndpoint: string;
  aceRuntimePath: string;
  aceAutoStart: boolean;
  aceStopOnExit: boolean;
  aceModel: string;
  aceLmModel: string;
  aceInferenceSteps: number;
  aceLmTemperature: number;
  audioFormat: 'mp3' | 'wav' | 'flac';
  lmEndpoint: string;
  lyricsModel: string;
  lyricsTemperature: number;
  unloadLyricsModel: boolean;
  libraryPath: string;
  /** Калибровка ETA: секунд генерации на секунду аудио, по числу вариантов. */
  calibration: { '1': number; '2': number; overhead: number };
}

export interface TrackVariant {
  file: string; // имя файла в папке трека
  seed?: string;
  favorite?: boolean;
}

export interface Track {
  id: string; // имя папки
  title: string;
  createdAt: string;
  params: TrackParams;
  lyrics: string; // текст, отправленный в ACE (после очистки)
  caption: string;
  bpm: number;
  variants: TrackVariant[];
  generationSeconds: number;
  favorite?: boolean;
}

export type JobPhase = 'idle' | 'preparing' | 'starting' | 'generating' | 'saving' | 'done' | 'error' | 'cancelled';

export interface JobState {
  id: string;
  phase: JobPhase;
  title: string;
  progress: number; // 0..1, монотонно растёт
  step: number; // 0 подготовка, 1 композиция, 2 синтез, 3 сохранение
  stageLabel: string;
  detail: string;
  elapsedSec: number;
  etaSec: number | null;
  trackId?: string;
  error?: string;
}

export type BackendState = 'online' | 'offline' | 'starting';

export interface BackendStatus {
  ace: BackendState;
  aceOwned: boolean;
  lm: BackendState;
}

export interface LmModelInfo {
  key: string;
  name: string;
  loaded: boolean;
}

export interface LyricsChunk {
  text: string; // накопленный видимый текст
  thinking: boolean;
}

export interface LyricsResult {
  title: string;
  text: string;
  warnings: string[];
}
