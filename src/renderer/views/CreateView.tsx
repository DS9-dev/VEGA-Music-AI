import { useEffect, useMemo, useRef, useState } from 'react';
import { GENRES, KEYS, LANGUAGES, MOODS, TIMBRES, resolveBpm } from '../../shared/catalog';
import { analyzeLyrics, fmtTime, planStructure, sanitizeLyrics } from '../../shared/lyrics';
import type { BackendStatus, Density, SongItem, TrackParams, VoiceItem } from '../../shared/types';
import { ChipPicker, Range, Segmented, ToggleRow, useToast } from '../components/ui';
import { LyricsEditor } from '../components/LyricsEditor';
import { ShiftPicker } from '../components/VoiceDialogs';
import { SECTION_RU } from '../sections';
import { IcChevron, IcDice, IcDisc, IcX, IcFemale, IcLock, IcMale, IcMic, IcPiano, IcSkull, IcSparkles, IcStop, IcTrash, IcUnlock, IcWand } from '../icons';


export interface Draft { title: string; text: string }

export function CreateView(props: {
  params: TrackParams;
  setParams: (p: TrackParams) => void;
  draft: Draft;
  setDraft: (d: Draft) => void;
  status: BackendStatus;
  busy: boolean;
  onCreate: () => void;
  voices: VoiceItem[];
  onOpenVoices: () => void;
  songs: SongItem[];
  onOpenSong: (id: string) => void;
}) {
  const { params: p, setParams, draft, setDraft } = props;
  const toast = useToast();
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const set = <K extends keyof TrackParams>(k: K, v: TrackParams[K]) => setParams({ ...p, [k]: v });

  const plan = useMemo(() => planStructure(p), [p]);
  const analysis = useMemo(() => analyzeLyrics(draft.text, p), [draft.text, p]);

  const draftRef = useRefLatest(draft);
  useEffect(() => window.api.lyrics.onChunk((c) => { setDraft({ ...draftRef.current, text: c.text }); setThinking(c.thinking); }), []);

  const genLyrics = async () => {
    if (streaming) { await window.api.lyrics.cancel(); return; }
    if (!p.theme.trim()) toast('info', 'Идея не задана — модель придумает тему сама');
    const prev = draft;
    setStreaming(true); setThinking(true);
    setDraft({ title: draft.title, text: '' });
    try {
      const r = await window.api.lyrics.generate(p);
      setDraft({ title: r.title, text: r.text });
      r.warnings.forEach((w) => toast('err', w));
      if (!r.warnings.length) toast('ok', 'Текст готов — можно править');
    } catch (e) {
      const msg = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (/abort/i.test(msg)) { toast('info', 'Генерация текста остановлена'); setDraft(prev.text ? prev : draftRef.current); }
      else { toast('err', msg); setDraft(prev); }
    } finally { setStreaming(false); setThinking(false); }
  };

  const fix = () => {
    const r = sanitizeLyrics(draft.text, { allowBacking: p.allowBacking, lang: p.language });
    setDraft({ ...draft, text: r.text });
    toast('ok', r.changes ? `Исправлено строк: ${r.changes}` : 'Всё уже в порядке');
  };

  const bpm = resolveBpm(p);
  const voice = p.voiceId ? props.voices.find((v) => v.id === p.voiceId && v.usable) : undefined;
  const timbres = TIMBRES[p.voice];
  const canCreate = !props.busy && !streaming && (p.instrumental || draft.text.trim().length > 0) && p.genres.length > 0 && !(p.voiceId && !voice && !p.instrumental);
  const genreLabels = GENRES.map((g) => g.label);
  const tooShort = !streaming && !p.instrumental && draft.text.trim() && analysis.estimatedSec < p.duration * 0.8;

  return (
    <div className="create">
      <div className="create-left">
        <div className="card">
          <div className="card-title">Идея песни</div>
          <textarea className="textarea" rows={5} value={p.theme} onChange={(e) => set('theme', e.target.value)}
            placeholder="О чём песня? Сюжет, герои, имена, настроение, ключевые образы…&#10;&#10;Например: ночной курьер мчится сквозь неоновый город под ливнем, чтобы успеть до рассвета" />
        </div>

        {p.sourceSongId && (() => {
          const src = props.songs.find((x) => x.id === p.sourceSongId);
          return (
            <div className="card source-card">
              <div className="card-title"><IcDisc size={16} /> Из песни
                <span className="hint" style={{ display: 'flex', gap: 6 }}>
                  {src && <button className="link-btn" onClick={() => props.onOpenSong(src.id)}>«{src.title}»</button>}
                  <button className="btn sm icon ghost" title="Отвязать от песни" onClick={() => setParams({ ...p, sourceSongId: null, cover: false })}><IcX size={13} /></button>
                </span>
              </div>
              {!src && <div className="plan-line" style={{ color: 'var(--warn)', marginTop: 0 }}>Исходная песня удалена — «по мотивам» недоступно.</div>}
              <ToggleRow on={!!p.cover && !!src} onChange={(v) => set('cover', v)}
                title="По мотивам оригинала" desc="Исходная песня — образец для ACE-Step: аранжировка и звучание будут похожи" />
              {p.cover && src && (
                <div className="field">
                  <div className="label">Сходство с оригиналом <span className="value">{Math.round((p.coverStrength ?? 0.5) * 100)}%</span></div>
                  <Range value={Math.round((p.coverStrength ?? 0.5) * 100)} min={10} max={100} step={5} onChange={(v) => set('coverStrength', v / 100)} />
                  <div className="range-scale"><span>только характер</span><span>близко к оригиналу</span></div>
                </div>
              )}
            </div>
          );
        })()}

        <div className="card">
          <div className="card-title">Жанр <span className="hint">можно несколько</span></div>
          <ChipPicker options={genreLabels} value={p.genres} onChange={(v) => set('genres', v)} allowCustom collapsedCount={14} placeholder="+ свой жанр" />
          <div className="field" style={{ marginTop: 16 }}>
            <div className="label">Настроение</div>
            <ChipPicker options={MOODS.map((m) => m.label)} value={p.moods} onChange={(v) => set('moods', v)} />
          </div>
          <div style={{ marginTop: 16 }}>
            <ToggleRow on={p.instrumental} onChange={(v) => set('instrumental', v)}
              title={<><IcPiano size={16} /> Только инструментал</>} desc="Трек без вокала — текст не нужен" />
            <ToggleRow className="dark" on={p.matureDark} onChange={(v) => set('matureDark', v)}
              title={<><IcSkull size={16} /> Mature Dark</>} desc="Мрачные, жестокие и аморальные сюжеты без смягчения" />
          </div>
        </div>

        {!p.instrumental && (
          <div className="card">
            <div className="card-title">Голос{props.voices.length === 0 && <span className="hint"><button className="link-btn" onClick={props.onOpenVoices}>Создать свой голос →</button></span>}</div>
            {props.voices.length > 0 && (
              <div className="field" style={{ marginBottom: 12 }}>
                <div className="label"><IcMic size={14} /> Исполнитель</div>
                <select className="select" value={p.voiceId ?? ''} onChange={(e) => {
                  const v = props.voices.find((x) => x.id === e.target.value);
                  setParams({ ...p, voiceId: v ? v.id : null, voice: v ? v.gender : p.voice });
                }}>
                  <option value="">Голос ACE-Step (стандартный)</option>
                  {props.voices.map((v) => (
                    <option key={v.id} value={v.id} disabled={!v.usable}>
                      {v.name}{v.usable ? (v.checkpoint ? ' · обучен' : ' · без обучения') : v.status === 'error' ? ' · ошибка' : ' · ещё обучается'}
                    </option>
                  ))}
                </select>
                {voice && <div className="plan-line">ACE-Step споёт мелодию {voice.gender === 'female' ? 'женским' : 'мужским'} голосом, затем вокал будет перепет голосом «{voice.name}». Займёт на 1–3 минуты дольше.</div>}
                {p.voiceId && !voice && <div className="plan-line" style={{ color: 'var(--warn)' }}>Выбранный голос недоступен — выберите другой.</div>}
              </div>
            )}
            {voice && (
              <div className="field" style={{ marginBottom: 12 }}>
                <div className="label">Тон голоса</div>
                <ShiftPicker compact value={p.voiceShift} onChange={(v) => set('voiceShift', v)} />
              </div>
            )}
            <Segmented value={p.voice} onChange={(v) => setParams({ ...p, voice: v, timbre: 'auto' })} options={[
              { value: 'male', label: <><IcMale size={15} /> Мужской</> },
              { value: 'female', label: <><IcFemale size={15} /> Женский</> },
            ]} />
            <div className="grid2" style={{ marginTop: 12 }}>
              <div className="field">
                <div className="label">Тембр</div>
                <select className="select" value={p.timbre} onChange={(e) => set('timbre', e.target.value)}>
                  {timbres.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div className="field" style={{ marginTop: 0 }}>
                <div className="label">Язык</div>
                <select className="select" value={p.language} onChange={(e) => set('language', e.target.value)}>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-title">Параметры</div>
          <div className="field">
            <div className="label">Длительность <span className="value">{fmtTime(p.duration)}</span></div>
            <Range value={p.duration} min={30} max={360} step={5} onChange={(v) => set('duration', v)} />
            <div className="range-scale"><span>0:30</span><span>2:00</span><span>4:00</span><span>6:00</span></div>
          </div>
          {!p.instrumental && (
            <div className="plan-line" style={{ marginTop: 10 }}>
              <b>План:</b> {plan.sections.map((s) => SECTION_RU[s.tag] ?? s.tag).join(' → ')}
              <br /><b>{plan.vocalLines} строк</b> · {bpm} BPM · ≈ {plan.timing.lineSec.toFixed(1)} с на строку
            </div>
          )}

          <details className="adv" style={{ marginTop: 16 }}>
            <summary><IcChevron size={14} /> Дополнительно</summary>
            <div className="adv-body">
              <div className="grid2">
                <div className="field">
                  <div className="label">Темп, BPM</div>
                  <input className="input" type="number" min={40} max={220} placeholder={`Авто (${bpm})`} value={p.bpm ?? ''}
                    onChange={(e) => set('bpm', e.target.value ? Number(e.target.value) : null)} />
                </div>
                <div className="field" style={{ marginTop: 0 }}>
                  <div className="label">Тональность</div>
                  <select className="select" value={p.key ?? ''} onChange={(e) => set('key', e.target.value || null)}>
                    <option value="">Авто</option>
                    {KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
              </div>
              {!p.instrumental && (
                <div className="field">
                  <div className="label">Плотность вокала</div>
                  <Segmented<Density> value={p.density} onChange={(v) => set('density', v)} options={[
                    { value: 'airy', label: 'Свободно' }, { value: 'normal', label: 'Обычно' }, { value: 'dense', label: 'Плотно' },
                  ]} />
                </div>
              )}
              <div className="field">
                <div className="label">Вариантов за раз</div>
                <Segmented<1 | 2> value={p.variants} onChange={(v) => set('variants', v)} options={[
                  { value: 1, label: '1 — быстрее' }, { value: 2, label: '2 — есть выбор' },
                ]} />
              </div>
              <div className="field">
                <div className="label">Seed (зерно случайности)</div>
                <div className="row">
                  <button className={`btn icon ${p.seedLocked ? 'soft' : ''}`} title={p.seedLocked ? 'Seed зафиксирован' : 'Случайный seed'}
                    onClick={() => set('seedLocked', !p.seedLocked)}>{p.seedLocked ? <IcLock size={16} /> : <IcUnlock size={16} />}</button>
                  <input className="input" type="number" disabled={!p.seedLocked} value={p.seed} onChange={(e) => set('seed', Number(e.target.value) || 0)} />
                  <button className="btn icon" title="Случайное число" onClick={() => setParams({ ...p, seed: Math.floor(Math.random() * 2 ** 31), seedLocked: true })}><IcDice size={16} /></button>
                </div>
              </div>
              <div className="field">
                <div className="label">Звучание, инструменты <span className="dim" style={{ fontWeight: 400 }}>(лучше по-английски)</span></div>
                <input className="input" placeholder="distorted guitars, dark synth pads, punchy drums" value={p.sound} onChange={(e) => set('sound', e.target.value)} />
              </div>
              {!p.instrumental && (
                <div className="field">
                  <ToggleRow on={p.allowBacking} onChange={(v) => set('allowBacking', v)}
                    title="Бэк-вокал в (скобках)" desc="Текст в скобках поётся подпевкой — может звучать другим голосом" />
                </div>
              )}
            </div>
          </details>
        </div>
      </div>

      <div className="create-right">
        <div className="card lyrics-card">
          <div className="lyrics-head">
            <input className="title-input" placeholder="Название трека" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            {!p.instrumental && <>
              <button className={`btn ${streaming ? '' : 'soft'}`} onClick={genLyrics} disabled={props.status.lm === 'offline' && !streaming}
                title={props.status.lm === 'offline' ? 'LM Studio не запущен' : ''}>
                {streaming ? <><IcStop size={14} /> Остановить</> : <><IcSparkles size={16} /> {draft.text.trim() ? 'Перегенерировать' : 'Сгенерировать текст'}</>}
              </button>
              <button className="btn icon" title="Исправить текст автоматически (теги, ремарки, скобки, цифры, длинные строки)" onClick={fix} disabled={streaming || !draft.text.trim()}><IcWand size={16} /></button>
              <button className="btn icon ghost" title="Очистить" onClick={() => setDraft({ ...draft, text: '' })} disabled={streaming || !draft.text}><IcTrash size={16} /></button>
            </>}
          </div>
          {p.instrumental ? (
            <div className="instr-empty">
              <div>
                <div className="big-ic"><IcPiano size={34} /></div>
                <h3 style={{ margin: '0 0 6px', color: 'var(--text)' }}>Инструментальный трек</h3>
                <div>Текст не нужен. Опишите звучание в «Дополнительно», если хотите точнее.</div>
              </div>
            </div>
          ) : (
            <LyricsEditor text={draft.text} onChange={(t) => setDraft({ ...draft, text: t })} params={p} streaming={streaming} thinking={thinking} />
          )}
        </div>

        <div className="action-bar">
          <div className="summary">
            <div className="summary-main">{draft.title || 'Без названия'}</div>
            <div className="summary-sub">
              {[p.genres.join(', ') || 'жанр не выбран', p.instrumental ? 'инструментал' : voice ? `голос «${voice.name}»` : `${p.voice === 'male' ? 'мужской' : 'женский'} вокал`, fmtTime(p.duration), `${bpm} BPM`, p.cover && p.sourceSongId ? 'по мотивам' : '', p.matureDark ? 'Mature Dark' : '']
                .filter(Boolean).join(' · ')}
            </div>
          </div>
          {tooShort && <span className="dim" style={{ fontSize: 12.5, color: 'var(--warn)' }}>Текста мало для {fmtTime(p.duration)}</span>}
          <button className="btn primary big" disabled={!canCreate} onClick={props.onCreate}
            title={props.status.ace === 'offline' ? 'ACE-Step будет запущен автоматически' : ''}>
            <IcSparkles size={18} /> Создать трек
          </button>
        </div>
      </div>
    </div>
  );
}

function useRefLatest<T>(v: T) { const r = useRef(v); r.current = v; return r; }
