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
  sourceSongId?: string | null; // песня, из которой взят текст (V3)
  cover?: boolean; // «по мотивам»: исходная песня идёт в ACE-Step как образец (режим cover)
  coverStrength?: number; // 0.1–1 — насколько близко к оригиналу
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
  // ── песни (V3) ──
  songsPath: string;
  asrBackend: AsrBackend;
  asrModel: string; // large-v3, large-v3-turbo, medium…
  asrModelsPath: string; // куда скачивать модели распознавания
  songLlmCleanup: boolean; // исправлять распознанный текст моделью из LM Studio
  aceBaseModel: string; // base-модель ACE-Step для режима «вокал поверх минуса» (lego)
}

export type AsrBackend = 'auto' | 'faster-whisper' | 'transformers';

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

export type JobKind = 'track' | 'voice' | 'revoice' | 'song' | 'remake';

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

export interface VoiceCheck { ok: boolean; problems: string[]; cuda: boolean | null; python?: string; asr?: string | null }

// ───────────────────────── Песни (V3) ─────────────────────────

export interface SongWord { w: string; s: number; e: number }
export interface SongLine { text: string; start: number; end: number }

export interface SongSection {
  tag: string; // Verse 1, Chorus, Intro, Instrumental, Outro…
  kind: 'vocal' | 'instrumental';
  start: number;
  end: number;
  lines: SongLine[];
  group?: string; // одинаковые группы — повторы (припев)
}

export type SongStatus = 'analyzing' | 'ready' | 'error';

export interface Song {
  id: string;
  title: string;
  createdAt: string;
  status: SongStatus;
  sourceName: string;
  source: string; // имя файла в папке песни
  vocals?: string;
  instrumental?: string;
  duration: number;
  bpm: number | null;
  key: string | null;
  gender: VoiceGender | null;
  f0Median?: number | null;
  note?: string;
  language: string; // код языка (распознанный или выбранный)
  sections: SongSection[];
  lyrics: string; // текст с тегами, правится пользователем
  recognized?: string; // как распознал Whisper, до исправлений
  caption?: string; // описание стиля (ACE-Step)
  genres?: string[];
  rewrite?: { theme: string; title: string; text: string; matureDark?: boolean; language?: string; createdAt: string };
  warnings: string[];
  error?: string;
}

export type SongItem = Song & { paths: { source: string; vocals?: string; instrumental?: string } };

export interface SongImportSpec { path: string; language: string | null; cleanup: boolean }

export interface RewriteSpec { theme: string; matureDark: boolean; text?: string; language?: string }

export interface RewriteResult {
  language?: string;
  title: string;
  text: string;
  warnings: string[];
  checks: { name: string; target: number; actual: number; level: string }[];
}

export type RemakeMethod = 'cover' | 'lego';

export interface RemakeSpec {
  songId: string;
  text: string;
  title: string;
  method: RemakeMethod;
  voiceId: string | null; // null — голос ACE-Step
  voiceShift: number | null;
  variants: 1 | 2;
  keepAce: boolean; // сохранять исходный вокал ACE-Step рядом
  language?: string; // язык текста (по умолчанию — язык песни)
  coverStrength?: number; // 0.3–1: насколько близко к оригиналу (cover)
  overlay?: boolean; // ещё и свести новый вокал с родным минусом
}

export interface SectionBudget { tag: string; group?: string; start: number; end: number; target: number; original: number; actual?: number }
