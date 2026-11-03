import type { TrackParams, VoiceGender } from './types';

export interface GenreDef {
  label: string;
  en: string;
  bpm: number;
  rap?: boolean;
  solo?: 'guitar' | 'piano' | 'synth';
}

export const GENRES: GenreDef[] = [
  { label: 'Рок', en: 'rock', bpm: 124, solo: 'guitar' },
  { label: 'Поп', en: 'pop', bpm: 112 },
  { label: 'Альтернатива', en: 'alternative rock', bpm: 120, solo: 'guitar' },
  { label: 'Метал', en: 'heavy metal', bpm: 140, solo: 'guitar' },
  { label: 'Панк', en: 'punk rock', bpm: 165, solo: 'guitar' },
  { label: 'Готик', en: 'gothic rock', bpm: 110, solo: 'guitar' },
  { label: 'Индастриал', en: 'industrial', bpm: 118, solo: 'synth' },
  { label: 'Хип-хоп', en: 'hip hop', bpm: 92, rap: true },
  { label: 'Рэп', en: 'rap', bpm: 90, rap: true },
  { label: 'Трэп', en: 'trap', bpm: 140, rap: true },
  { label: 'Фонк', en: 'phonk', bpm: 135, rap: true },
  { label: 'Электроника', en: 'electronic', bpm: 124, solo: 'synth' },
  { label: 'Синтвейв', en: 'synthwave', bpm: 105, solo: 'synth' },
  { label: 'Хаус', en: 'house', bpm: 124, solo: 'synth' },
  { label: 'Техно', en: 'techno', bpm: 130, solo: 'synth' },
  { label: 'Драм-н-бейс', en: 'drum and bass', bpm: 172, solo: 'synth' },
  { label: 'R&B', en: 'r&b', bpm: 90 },
  { label: 'Соул', en: 'soul', bpm: 95 },
  { label: 'Фанк', en: 'funk', bpm: 108, solo: 'guitar' },
  { label: 'Диско', en: 'disco', bpm: 118 },
  { label: 'Джаз', en: 'jazz', bpm: 120, solo: 'piano' },
  { label: 'Блюз', en: 'blues', bpm: 85, solo: 'guitar' },
  { label: 'Фолк', en: 'folk', bpm: 100 },
  { label: 'Кантри', en: 'country', bpm: 110, solo: 'guitar' },
  { label: 'Шансон', en: 'russian chanson', bpm: 100 },
  { label: 'Регги', en: 'reggae', bpm: 80 },
  { label: 'Инди', en: 'indie', bpm: 115 },
  { label: 'Лоу-фай', en: 'lo-fi', bpm: 80, solo: 'piano' },
  { label: 'Баллада', en: 'ballad', bpm: 72, solo: 'piano' },
  { label: 'Эмбиент', en: 'ambient', bpm: 80, solo: 'synth' },
  { label: 'Оркестр', en: 'orchestral', bpm: 100 },
  { label: 'Саундтрек', en: 'cinematic soundtrack', bpm: 95 },
];

export interface MoodDef { label: string; en: string }
export const MOODS: MoodDef[] = [
  { label: 'Мрачное', en: 'dark' },
  { label: 'Энергичное', en: 'energetic' },
  { label: 'Грустное', en: 'melancholic' },
  { label: 'Эпичное', en: 'epic' },
  { label: 'Агрессивное', en: 'aggressive' },
  { label: 'Весёлое', en: 'upbeat, cheerful' },
  { label: 'Романтичное', en: 'romantic' },
  { label: 'Мечтательное', en: 'dreamy' },
  { label: 'Ностальгия', en: 'nostalgic' },
  { label: 'Тревожное', en: 'tense, anxious' },
  { label: 'Ироничное', en: 'playful, ironic' },
  { label: 'Спокойное', en: 'calm, relaxed' },
];

export interface TimbreDef { id: string; label: string; en: string }
export const TIMBRES: Record<VoiceGender, TimbreDef[]> = {
  male: [
    { id: 'auto', label: 'Авто', en: '' },
    { id: 'baritone', label: 'Баритон', en: 'warm baritone' },
    { id: 'deep', label: 'Низкий, бархатный', en: 'deep low voice' },
    { id: 'tenor', label: 'Тенор, чистый', en: 'clear tenor' },
    { id: 'raspy', label: 'С хрипотцой', en: 'raspy gritty voice' },
    { id: 'powerful', label: 'Мощный', en: 'powerful belting' },
    { id: 'soft', label: 'Мягкий', en: 'soft breathy voice' },
    { id: 'rap', label: 'Рэп-подача', en: 'rhythmic rap delivery' },
  ],
  female: [
    { id: 'auto', label: 'Авто', en: '' },
    { id: 'alto', label: 'Альт, тёплый', en: 'warm alto' },
    { id: 'soprano', label: 'Сопрано, светлый', en: 'bright soprano' },
    { id: 'breathy', label: 'Воздушный', en: 'airy breathy voice' },
    { id: 'raspy', label: 'Дымчатый, с хрипотцой', en: 'smoky raspy voice' },
    { id: 'powerful', label: 'Мощный', en: 'powerful belting' },
    { id: 'soft', label: 'Нежный', en: 'gentle soft voice' },
    { id: 'rap', label: 'Рэп-подача', en: 'rhythmic rap delivery' },
  ],
};

export interface LangDef { code: string; label: string; en: string }
export const LANGUAGES: LangDef[] = [
  { code: 'ru', label: 'Русский', en: 'Russian' },
  { code: 'en', label: 'English', en: 'English' },
  { code: 'uk', label: 'Українська', en: 'Ukrainian' },
  { code: 'de', label: 'Deutsch', en: 'German' },
  { code: 'es', label: 'Español', en: 'Spanish' },
  { code: 'fr', label: 'Français', en: 'French' },
  { code: 'it', label: 'Italiano', en: 'Italian' },
  { code: 'pt', label: 'Português', en: 'Portuguese' },
  { code: 'ja', label: '日本語', en: 'Japanese' },
  { code: 'ko', label: '한국어', en: 'Korean' },
  { code: 'zh', label: '中文', en: 'Chinese' },
];

export const KEYS = ['C major', 'C minor', 'C# major', 'C# minor', 'D major', 'D minor', 'D# major', 'D# minor', 'E major', 'E minor',
  'F major', 'F minor', 'F# major', 'F# minor', 'G major', 'G minor', 'G# major', 'G# minor', 'A major', 'A minor',
  'A# major', 'A# minor', 'B major', 'B minor'];

export function findGenre(label: string): GenreDef | undefined {
  const l = label.trim().toLowerCase();
  return GENRES.find((g) => g.label.toLowerCase() === l || g.en === l);
}

export function genreEn(label: string): string {
  return findGenre(label)?.en ?? label.trim().toLowerCase();
}

export function langDef(code: string): LangDef {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

export function isRapLike(genres: string[]): boolean {
  return genres.some((g) => findGenre(g)?.rap || /rap|рэп|hip.?hop|хип|trap|трэп|drill|дрилл/i.test(g));
}

export function resolveBpm(p: Pick<TrackParams, 'bpm' | 'genres'>): number {
  if (p.bpm && p.bpm >= 40 && p.bpm <= 220) return Math.round(p.bpm);
  for (const g of p.genres) {
    const def = findGenre(g);
    if (def) return def.bpm;
  }
  return 115;
}

export function soloTag(genres: string[]): string {
  for (const g of genres) {
    const s = findGenre(g)?.solo;
    if (s === 'guitar') return 'Guitar Solo';
    if (s === 'piano') return 'Piano Interlude';
  }
  return 'Instrumental';
}

export const DEFAULT_PARAMS: TrackParams = {
  theme: '',
  genres: ['Рок'],
  moods: [],
  instrumental: false,
  matureDark: false,
  voice: 'male',
  timbre: 'auto',
  language: 'ru',
  duration: 210,
  bpm: null,
  key: null,
  density: 'normal',
  variants: 2,
  seedLocked: false,
  seed: 42,
  sound: '',
  allowBacking: false,
  voiceId: null,
  voiceShift: null,
  sourceSongId: null,
  cover: false,
  coverStrength: 0.5,
};
