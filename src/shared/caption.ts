/**
 * Сборка caption (описания стиля) и запроса к ACE-Step.
 * Важно: пол и тембр вокала всегда в caption, BPM/тональность — отдельными полями,
 * LM не переписывает caption (use_cot_caption=false) — это убирает «плавающий» голос.
 */
import { MOODS, TIMBRES, genreEn } from './catalog';
import { sanitizeLyrics, timing } from './lyrics';
import type { Settings, TrackParams } from './types';

export function buildCaption(p: TrackParams): string {
  const parts: string[] = [];
  const genres = unique(p.genres.map(genreEn).filter(Boolean));
  parts.push(...genres);
  for (const m of p.moods) parts.push(MOODS.find((x) => x.label === m)?.en ?? m.toLowerCase());
  if (p.matureDark) parts.push('dark', 'sinister ominous atmosphere');
  if (p.sound.trim()) parts.push(p.sound.trim().replace(/[.\n]+/g, ', '));
  if (p.instrumental) {
    parts.push('instrumental', 'no vocals');
  } else {
    const timbre = TIMBRES[p.voice].find((t) => t.id === p.timbre)?.en ?? '';
    parts.push(`${p.voice} vocal`);
    if (timbre) parts.push(timbre);
    parts.push('single lead vocalist', 'clear articulate vocals');
  }
  return unique(parts.flatMap((x) => x.split(/\s*,\s*/)).map((x) => x.trim()).filter(Boolean)).join(', ');
}

export function lyricsForAce(p: TrackParams, text: string): string {
  if (p.instrumental) return '[Instrumental]';
  return sanitizeLyrics(text, { allowBacking: p.allowBacking, lang: p.language }).text;
}

export function buildAceRequest(p: TrackParams, lyrics: string, s: Settings): Record<string, unknown> {
  const t = timing(p);
  const req: Record<string, unknown> = {
    prompt: buildCaption(p),
    lyrics: lyricsForAce(p, lyrics),
    thinking: true,
    model: s.aceModel,
    lm_model_path: s.aceLmModel,
    lm_backend: 'pt',
    audio_duration: p.duration,
    audio_format: s.audioFormat,
    vocal_language: p.instrumental ? 'en' : p.language,
    inference_steps: s.aceInferenceSteps,
    bpm: t.bpm,
    time_signature: '4',
    batch_size: p.variants,
    use_cot_caption: false,
    use_cot_language: false,
    lm_temperature: s.aceLmTemperature,
    use_random_seed: !p.seedLocked,
  };
  if (p.key) req.key_scale = p.key;
  if (p.seedLocked) req.seed = p.seed;
  return req;
}

function unique<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  return arr.filter((x) => {
    const k = String(x).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
