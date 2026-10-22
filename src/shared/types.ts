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
  voiceId: string | null; // своя голосовая модель (V2) или null — голос ACE-Step
  voiceShift: number | null; // сдвиг тона для голосовой модели, null — авто (кратно октаве)
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
  // ── голосовые модели (V2) ──
  seedvcPath: string; // папка Seed-VC (inference.py, train.py, .venv)
  separatorPath: string; // папка с .venv\Scripts\melband-roformer-infer.exe
  melbandModelsPath: string; // папка моделей MelBand-RoFormer
  transformersCachePath: string; // кэш Whisper для Seed-VC (пусто — скачивать из интернета)
  voicesPath: string;
  voiceDiffusionSteps: number; // 25–50
  freeAceForVoice: boolean; // останавливать ACE-Step перед обработкой голоса (экономия видеопамяти)
}

export interface TrackVariant {
  file: string; // имя файла в папке трека
  seed?: string;
  favorite?: boolean;
  label?: string; // подпись в библиотеке (например «Вариант 1 · ACE»)
  original?: boolean; // исходный вокал ACE-Step до перепевки
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
  voiceName?: string; // голосовая модель, которой спет трек
}

export type JobPhase = 'idle' | 'preparing' | 'starting' | 'generating' | 'saving' | 'done' | 'error' | 'cancelled';

export type JobKind = 'track' | 'voice' | 'revoice';

export interface JobState {
  id: string;
  kind?: JobKind;
  steps?: string[]; // названия этапов для индикатора
  targetId?: string; // id голоса для заданий голоса
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

// ───────────────────────── Голосовые модели (V2) ─────────────────────────

export type VoiceStatus = 'preparing' | 'training' | 'ready' | 'error';
export type VoiceTrainProfile = 'zero' | 'quick' | 'standard' | 'max';
export type VoiceSourceKind = 'song' | 'clean';

export interface VoiceSource {
  file: string; // имя файла в sources/
  name: string; // исходное имя
  kind: VoiceSourceKind;
}

export interface VoiceModel {
  id: string; // имя папки
  name: string;
  gender: VoiceGender;
  createdAt: string;
  updatedAt: string;
  status: VoiceStatus;
  profile: VoiceTrainProfile;
  sources: VoiceSource[];
  dataset?: { segments: number; seconds: number; warnings: string[] };
  reference?: string; // reference.wav
  f0Median?: number | null;
  note?: string; // средняя нота голоса, напр. «G3»
  training?: { steps: number; seconds: number; finalLoss: number | null };
  checkpoint?: string; // model/ft_model.pth (нет — режим «без обучения»)
  config?: string;
  error?: string;
  consent: boolean;
}

export interface NewVoiceSpec {
  name: string;
  gender: VoiceGender;
  sources: { path: string; kind: VoiceSourceKind }[];
  profile: VoiceTrainProfile;
  consent: boolean;
}

export type VoiceItem = VoiceModel & { usable: boolean };

export const VOICE_PROFILE_STEPS: Record<VoiceTrainProfile, number> = { zero: 0, quick: 300, standard: 800, max: 2000 };

export interface VoiceCheck { ok: boolean; problems: string[]; cuda: boolean | null; python?: string }
