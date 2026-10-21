/** Промпт для LLM (Qwen3 и др. в LM Studio), пишущей текст песни. */
import { genreEn, langDef, MOODS, TIMBRES } from './catalog';
import type { StructurePlan } from './lyrics';
import type { TrackParams } from './types';

export function buildLyricsMessages(p: TrackParams, plan: StructurePlan) {
  const lang = langDef(p.language);
  const sectionsSpec = plan.unique
    .map((u) => `[${u.tag}] — exactly ${u.lines} lines${u.key === 'C' ? ' (the hook; will be repeated automatically, write it once)' : u.key === 'P' ? ' (builds tension into the chorus; written once)' : ''}`)
    .join('\n');
  const rap = p.timbre === 'rap' || p.genres.some((g) => /рэп|rap|хип|hip|trap|трэп|фонк|phonk/i.test(g));

  const system = [
    'You are an award-winning professional songwriter. You write lyrics that will be sung by an AI singing model (ACE-Step).',
    `Write ALL sung lines in ${lang.en} only.${lang.code === 'ru' ? ' Use natural, modern, idiomatic Russian with correct word stress that falls naturally on strong beats.' : ''}`,
    '',
    'OUTPUT FORMAT (strict, nothing else):',
    `TITLE: <short song title in ${lang.en}>`,
    '[Section Name]',
    'line',
    'line',
    '',
    'Write exactly these sections, in this order:',
    sectionsSpec,
    '',
    'RULES:',
    rap
      ? '- Rap flow: each line 8–14 syllables, strong internal rhymes and multisyllabic end rhymes, consistent rhythm.'
      : '- Each line 6–10 syllables (never more than 12), singable in one breath; lines in the same position of a section have similar length (±2 syllables).',
    '- Clear rhyme scheme inside each section (AABB or ABAB).',
    '- The chorus is catchy and memorable and contains the song title or the main hook phrase.',
    '- Verses tell the story step by step; Verse 2 develops the story further and never repeats Verse 1. The bridge brings a twist or a new angle.',
    '- One core image/metaphor per song, concrete details instead of vague adjectives.',
    '- NEVER write: stage directions, sound effects, descriptions of music or voice, speaker names, text in parentheses or brackets inside lines, asterisks, quotes, emojis, digits (write numbers as words), translations, comments or explanations.',
    '- Each line is plain singable text only.',
    '',
    p.matureDark
      ? 'MATURE DARK MODE IS ON. This is fiction for a dark-themed song. Grim, morbid, morally twisted, violent or villainous themes, black humor and an unrepentant villain narrator are allowed and desired. Do not soften the story, do not moralize, do not add a happy ending unless asked. Harsh language is allowed when it fits. Hard limit: no sexual content involving minors.'
      : 'Keep the lyrics suitable for a general audience.',
  ].join('\n');

  const genres = p.genres.map((g) => `${g} (${genreEn(g)})`).join(', ') || 'any';
  const moods = p.moods.map((m) => MOODS.find((x) => x.label === m)?.en ?? m).join(', ');
  const timbre = TIMBRES[p.voice].find((t) => t.id === p.timbre)?.en;
  const user = [
    `Song idea / what the lyrics must be about:\n${p.theme.trim() || 'Free choice — surprise me.'}`,
    '',
    `Genre: ${genres}`,
    moods ? `Mood: ${moods}` : '',
    `Singer: ${p.voice === 'male' ? 'male' : 'female'}${timbre ? `, ${timbre}` : ''} (write from a perspective that fits this singer)`,
    `Tempo: ${plan.timing.bpm} BPM`,
    '',
    'Write the lyrics now. /no_think',
  ].filter((x) => x !== '').join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
