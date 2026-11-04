import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PARAMS, LANGUAGES } from '../../shared/catalog';
import { fmtTime, normalizeTag } from '../../shared/lyrics';
import { budgetLevel, detectLanguage, measureBudgets, sectionBudgets, songTrackParams } from '../../shared/song';
import type { BackendStatus, JobState, SongItem, SongSection, VoiceItem } from '../../shared/types';
import { LyricsEditor } from '../components/LyricsEditor';
import { ImportDialog, RemakeDialog } from '../components/SongDialogs';
import { Cover, Segmented, ToggleRow, useToast } from '../components/ui';
import { NewVoiceDialog } from '../components/VoiceDialogs';
import {
  IcAlert, IcArrowRight, IcDisc, IcFemale, IcFolder, IcMale, IcMic, IcPause, IcPlay, IcPlus, IcRefresh, IcRepeat, IcSkull, IcSparkles, IcStop, IcTrash, IcWand, IcWave,
} from '../icons';
import { SECTION_RU } from '../sections';

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const RUNNING = ['preparing', 'starting', 'generating', 'saving'];

type Which = 'source' | 'vocals' | 'instrumental';

function sectionClass(s: SongSection): string {
  if (s.kind === 'instrumental') return 'inst';
  const b = normalizeTag(s.tag).base;
  return b === 'Chorus' ? 'chorus' : b === 'Pre-Chorus' || b === 'Post-Chorus' ? 'pre' : b === 'Bridge' ? 'bridge' : 'verse';
}

function ru(tag: string): string {
  const t = normalizeTag(tag);
  if (t.base === 'Verse') return tag.replace('Verse', 'Куплет');
  return SECTION_RU[t.base] ?? tag;
}

export function SongsView(props: {
  songs: SongItem[];
  refresh: () => void;
  job: JobState | null;
  focusId: string | null;
  status: BackendStatus;
  voices: VoiceItem[];
  onJobStarted: () => void;
  onVoiceStarted: () => void;
  onUseText: (song: SongItem, text: string, title: string, language: string) => void;
}) {
  const toast = useToast();
  const [sel, setSel] = useState<string | null>(props.focusId);
  const [importPath, setImportPath] = useState<string | null>(null);
  useEffect(() => { if (props.focusId) setSel(props.focusId); }, [props.focusId]);
  const song = props.songs.find((s) => s.id === sel) ?? props.songs[0];

  const pick = async () => {
    const p = await window.api.songs.pick();
    if (p) setImportPath(p);
  };

  const running = props.job && RUNNING.includes(props.job.phase) && props.job.kind === 'song' ? props.job : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Из песни</h1>
          <p className="page-sub">Загрузите песню — получите текст с припевами, перепишите его на свою тему и спойте на эту же музыку</p>
        </div>
        <div className="page-actions">
          <button className="btn icon" onClick={() => window.api.songs.openRoot()} title="Папка песен"><IcFolder size={16} /></button>
          <button className="btn primary" onClick={pick} disabled={!!running}><IcPlus size={16} /> Загрузить песню</button>
        </div>
      </div>

      {props.songs.length === 0 ? (
        <div className="empty">
          <div className="big-ic"><IcDisc size={36} /></div>
          <h3>Начните с любимой песни</h3>
          <p>VEGA-Music-AI отделит голос от музыки, распознает слова и найдёт куплеты и припевы.</p>
          <div className="how">
            <div><span className="n">1</span><b>Разбор</b>Вокал и минус разделяются, Whisper распознаёт слова, Qwen исправляет ослышки.</div>
            <div><span className="n">2</span><b>Текст</b>Поправьте текст или перепишите его на свою тему — с тем же числом слогов в секциях.</div>
            <div><span className="n">3</span><b>Музыка</b>Своя музыка, «по мотивам» оригинала или новые слова на эту же музыку.</div>
          </div>
          <button className="btn primary big" onClick={pick}><IcPlus size={18} /> Загрузить песню</button>
        </div>
      ) : (
        <div className="songs">
          <div className="song-list">
            {props.songs.map((s) => {
              const job = running?.targetId === s.id ? running : null;
              return (
                <button key={s.id} className={`song-item ${song?.id === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)}>
                  <Cover title={s.title} small />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="song-item-title">{s.title}</div>
                    <div className="song-item-meta">
                      {s.status === 'analyzing' ? (job ? `${job.stageLabel} · ${Math.floor(job.progress * 100)}%` : 'Прервано')
                        : s.status === 'error' ? 'Ошибка разбора'
                          : [fmtTime(s.duration), s.bpm ? `${s.bpm} BPM` : '', s.rewrite ? 'есть новый текст' : ''].filter(Boolean).join(' · ')}
                    </div>
                    {job && <div className="mini-progress" style={{ marginTop: 6 }}><i style={{ width: `${Math.max(3, job.progress * 100)}%` }} /></div>}
                  </div>
                </button>
              );
            })}
          </div>
          {song && <SongDetail key={song.id} song={song} {...props} toast={toast} job={running?.targetId === song.id ? running : null} />}
        </div>
      )}

      {importPath && <ImportDialog path={importPath} lmOnline={props.status.lm === 'online'} onClose={() => setImportPath(null)}
        onStarted={() => { setImportPath(null); props.refresh(); props.onJobStarted(); }} />}
    </>
  );
}

function SongDetail(props: {
  song: SongItem;
  refresh: () => void;
  job: JobState | null;
  status: BackendStatus;
  voices: VoiceItem[];
  onJobStarted: () => void;
  onVoiceStarted: () => void;
  onUseText: (song: SongItem, text: string, title: string, language: string) => void;
  toast: ReturnType<typeof useToast>;
}) {
  const { song, toast } = props;
  const [tab, setTab] = useState<'orig' | 'new'>(song.rewrite ? 'new' : 'orig');
  const [text, setText] = useState(song.lyrics);
  const [newText, setNewText] = useState(song.rewrite?.text ?? '');
  const [newTitle, setNewTitle] = useState(song.rewrite?.title ?? '');
  const [theme, setTheme] = useState(song.rewrite?.theme ?? '');
  const [mature, setMature] = useState(!!song.rewrite?.matureDark);
  const [rwLang, setRwLang] = useState(song.rewrite?.language ?? song.language);
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [showTheme, setShowTheme] = useState(!song.rewrite);
  const [remake, setRemake] = useState(false);
  const [voiceDlg, setVoiceDlg] = useState(false);
  const [busy, setBusy] = useState<'' | 'style' | 'cleanup'>('');
  const [playing, setPlaying] = useState<Which | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const audio = useRef<HTMLAudioElement>(new Audio());

  useEffect(() => {
    const a = audio.current;
    const end = () => setPlaying(null);
    a.addEventListener('ended', end);
    return () => { a.pause(); a.removeEventListener('ended', end); };
  }, []);
  useEffect(() => { if (!streaming) setText(song.lyrics); }, [song.lyrics]);

  // сохранение правок с задержкой
  const firstOrig = useRef(true);
  useEffect(() => {
    if (firstOrig.current) { firstOrig.current = false; return; }
    const t = setTimeout(() => { void window.api.songs.update(song.id, { lyrics: text }).then(props.refresh).catch(() => {}); }, 600);
    return () => clearTimeout(t);
  }, [text]);
  const firstNew = useRef(true);
  useEffect(() => {
    if (firstNew.current) { firstNew.current = false; return; }
    if (streaming || !song.rewrite) return;
    const t = setTimeout(() => {
      void window.api.songs.update(song.id, { rewrite: { ...song.rewrite!, text: newText, title: newTitle } }).then(props.refresh).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [newText, newTitle]);

  useEffect(() => window.api.songs.onChunk((c) => { setNewText(c.text.replace(/^TITLE:.*\n?/i, '')); setThinking(c.thinking); }), []);

  const params = useMemo(() => ({ ...songTrackParams(song, DEFAULT_PARAMS), duration: Math.max(30, Math.round(song.duration)) }), [song]);
  const newLang = streaming ? rwLang : song.rewrite?.language ?? rwLang;
  const newParams = useMemo(() => ({ ...params, language: newLang }), [params, newLang]);
  const budgets = useMemo(() => measureBudgets(sectionBudgets(song.sections, text), newText), [song.sections, text, newText]);

  const play = async (w: Which) => {
    const a = audio.current;
    if (playing === w) { a.pause(); setPlaying(null); return; }
    try {
      const raw = await window.api.songs.readAudio(song.id, w);
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array((raw as Uint8Array).buffer, (raw as Uint8Array).byteOffset, (raw as Uint8Array).byteLength);
      const ext = w === 'source' ? song.source.split('.').pop() : 'wav';
      a.src = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}` }));
      await a.play();
      setPlaying(w);
    } catch (e) { toast('err', errText(e)); }
  };

  const rewrite = async () => {
    if (streaming) { await window.api.songs.cancelRewrite(); return; }
    if (!theme.trim()) toast('info', 'Тема не задана — модель придумает её сама');
    const prev = { newText, newTitle };
    setStreaming(true); setThinking(true); setTab('new'); setNewText('');
    try {
      const r = await window.api.songs.rewrite(song.id, { theme, matureDark: mature, text, language: rwLang });
      setNewText(r.text); setNewTitle(r.title); setShowTheme(false);
      r.warnings.forEach((w) => toast('err', w));
      if (!r.warnings.length) toast('ok', 'Новый текст готов — слоги совпадают с оригиналом');
      props.refresh();
    } catch (e) {
      const msg = errText(e);
      if (/abort/i.test(msg)) toast('info', 'Переписывание остановлено'); else toast('err', msg);
      setNewText(prev.newText); setNewTitle(prev.newTitle);
    } finally { setStreaming(false); setThinking(false); }
  };

  const analyzeStyle = async () => {
    setBusy('style');
    try { await window.api.songs.analyzeStyle(song.id); props.refresh(); toast('ok', 'Стиль определён'); } catch (e) { toast('err', errText(e)); } finally { setBusy(''); }
  };
  const cleanup = async () => {
    setBusy('cleanup');
    try { const s = await window.api.songs.cleanup(song.id); setText(s.lyrics); props.refresh(); toast('ok', 'Текст исправлен моделью'); } catch (e) { toast('err', errText(e)); } finally { setBusy(''); }
  };
  const remove = async () => {
    if (!confirmDel) { setConfirmDel(true); setTimeout(() => setConfirmDel(false), 3000); return; }
    await window.api.songs.remove(song.id);
    toast('ok', `«${song.title}» перемещена в корзину`);
    props.refresh();
  };

  const useNew = tab === 'new' && newText.trim().length > 0;
  const actText = useNew ? newText : text;
  const actTitle = useNew ? newTitle || `${song.title} (новый текст)` : song.title;
  const actLang = detectLanguage(actText, useNew ? newLang : song.language);
  const toggleGender = async () => {
    const g = song.gender === 'female' ? 'male' : 'female';
    await window.api.songs.update(song.id, { gender: g });
    props.refresh();
    toast('ok', g === 'male' ? 'Голос исполнителя: мужской' : 'Голос исполнителя: женский');
  };
  const lang = LANGUAGES.find((l) => l.code === song.language)?.label ?? song.language;

  if (song.status === 'analyzing') {
    return (
      <div className="song-detail">
        <div className="card song-wait">
          <div className="big-ic pulse"><IcWave size={34} /></div>
          <h3>{props.job ? props.job.stageLabel : 'Разбор прерван'}</h3>
          <p className="dim">{props.job ? props.job.detail : 'Приложение закрылось во время разбора. Удалите песню и загрузите её снова.'}</p>
          {props.job && <div className="mini-progress" style={{ maxWidth: 360, margin: '14px auto 0' }}><i style={{ width: `${Math.max(3, props.job.progress * 100)}%` }} /></div>}
          {!props.job && <button className="btn" style={{ marginTop: 14 }} onClick={remove}><IcTrash size={14} /> {confirmDel ? 'Точно удалить?' : 'Удалить'}</button>}
        </div>
      </div>
    );
  }
  if (song.status === 'error') {
    return (
      <div className="song-detail">
        <div className="card song-wait">
          <div className="big-ic err"><IcAlert size={34} /></div>
          <h3>Не удалось разобрать песню</h3>
          <div className="voice-error" style={{ textAlign: 'left', marginTop: 10 }}>{song.error}</div>
          <button className="btn" style={{ marginTop: 14 }} onClick={remove}><IcTrash size={14} /> {confirmDel ? 'Точно удалить?' : 'Удалить'}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="song-detail">
      <div className="card song-head">
        <Cover title={song.title} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <input className="song-title-input" defaultValue={song.title} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== song.title) void window.api.songs.update(song.id, { title: e.target.value }).then(props.refresh); }} />
          <div className="song-meta">
            <span>{fmtTime(song.duration)}</span>
            {song.bpm && <span>{song.bpm} BPM</span>}
            {song.key && <span>{song.key}</span>}
            <button className="meta-btn" onClick={toggleGender} title="Определено по высоте голоса. Нажмите, если неверно — от этого зависит, каким голосом ACE-Step споёт новые слова">
              {song.gender === 'female' ? <IcFemale size={12} /> : <IcMale size={12} />}{song.gender === 'female' ? 'Женский голос' : song.gender === 'male' ? 'Мужской голос' : 'Голос не определён'}{song.note ? ` · ${song.note}` : ''}<IcRepeat size={11} />
            </button>
            {lang && <span>{lang}</span>}
          </div>
          <div className="song-play">
            {([['source', 'Оригинал'], ['vocals', 'Вокал'], ['instrumental', 'Минус']] as [Which, string][]).map(([w, label]) => (
              <button key={w} className={`btn sm ${playing === w ? 'soft' : ''}`} disabled={w !== 'source' && !song.paths[w]} onClick={() => play(w)}>
                {playing === w ? <IcPause size={12} /> : <IcPlay size={12} />} {label}
              </button>
            ))}
          </div>
        </div>
        <div className="song-head-actions">
          <button className="btn sm icon ghost" title="Показать в папке" onClick={() => window.api.songs.reveal(song.id)}><IcFolder size={14} /></button>
          <button className={`btn sm ${confirmDel ? 'danger' : 'icon ghost'}`} title="Удалить в корзину" onClick={remove}><IcTrash size={14} />{confirmDel ? ' Точно?' : ''}</button>
        </div>
      </div>

      <Timeline song={song} />

      {song.warnings.length > 0 && (
        <div className="banner" style={{ margin: 0 }}><IcAlert size={18} /><div>{song.warnings.map((w) => <div key={w}>{w}</div>)}</div></div>
      )}

      <div className="song-body">
        <div className="card lyrics-card song-lyrics">
          <div className="lyrics-head">
            <Segmented<'orig' | 'new'> value={tab} onChange={setTab} options={[
              { value: 'orig', label: 'Текст песни' },
              { value: 'new', label: <>Новый текст{song.rewrite && <span className="dot-mini" />}</> },
            ]} />
            <span style={{ flex: 1 }} />
            {tab === 'orig' && (
              <button className="btn sm" onClick={cleanup} disabled={!!busy || props.status.lm === 'offline'} title={props.status.lm === 'offline' ? 'LM Studio не запущен' : 'Qwen поправит ослышки и разметит секции'}>
                {busy === 'cleanup' ? <span className="spin" /> : <IcWand size={14} />} Исправить моделью
              </button>
            )}
            {tab === 'new' && !showTheme && !streaming && (
              <button className="btn sm" onClick={() => setShowTheme(true)}><IcRefresh size={14} /> Другая тема</button>
            )}
          </div>

          {tab === 'new' && (showTheme || streaming) && (
            <div className="theme-box">
              <textarea className="textarea" rows={2} value={theme} onChange={(e) => setTheme(e.target.value)} disabled={streaming}
                placeholder="О чём будет новый текст? Например: космонавт возвращается домой после долгой экспедиции" />
              <div className="row" style={{ marginTop: 10 }}>
                <select className="select lang-select" value={rwLang} onChange={(e) => setRwLang(e.target.value)} disabled={streaming} title="Язык нового текста">
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}{l.code === song.language ? ' · как в песне' : ''}</option>)}
                </select>
                <ToggleRow className="dark compact" on={mature} onChange={setMature} title={<><IcSkull size={14} /> Mature Dark</>} />
                <span style={{ flex: 1 }} />
                <button className={`btn ${streaming ? '' : 'primary'}`} onClick={rewrite} disabled={props.status.lm === 'offline' && !streaming}
                  title={props.status.lm === 'offline' ? 'LM Studio не запущен' : ''}>
                  {streaming ? <><IcStop size={14} /> Остановить</> : <><IcSparkles size={16} /> {song.rewrite ? 'Переписать заново' : 'Переписать'}</>}
                </button>
              </div>
              <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>Структура сохранится: те же секции и припевы, в каждой секции — столько же слогов, сколько в оригинале. Число строк может отличаться.{rwLang !== song.language ? ' Текст будет на другом языке — слоги считаются по нему.' : ''}</div>
            </div>
          )}

          {tab === 'new' && !showTheme && !streaming && newText && (
            <div className="new-title-row"><input className="title-input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Название" /></div>
          )}

          {tab === 'orig'
            ? <LyricsEditor songMode text={text} onChange={setText} params={params} streaming={false} thinking={false} />
            : newText || streaming
              ? <LyricsEditor songMode text={newText} onChange={setNewText} params={newParams} streaming={streaming} thinking={thinking} />
              : <div className="instr-empty"><div><div className="big-ic"><IcSparkles size={30} /></div><h3 style={{ margin: '0 0 6px', color: 'var(--text)' }}>Текст на новую тему</h3><div>Задайте тему выше — модель перепишет песню, сохранив её ритм.</div></div></div>}

          {tab === 'new' && newText && !streaming && (
            <div className="fit-row">
              <span className="dim">Попадание в такт:</span>
              {budgets.map((b, i) => (
                <span key={i} className={`fit ${budgetLevel(b)}`} title={`${ru(b.tag)}: ${b.actual} слогов, нужно ≈ ${b.target}`}>{ru(b.tag)} <b>{b.actual}/{b.target}</b></span>
              ))}
            </div>
          )}
        </div>

        <div className="song-actions">
          <div className="card song-action">
            <div className="sa-ic"><IcSparkles size={18} /></div>
            <h4>Своя музыка на этот текст</h4>
            <p>Откроется «Создать» с {useNew ? 'новым текстом' : 'текстом песни'}, темпом{song.bpm ? ` ${song.bpm} BPM` : ''} и длительностью оригинала. Включите «По мотивам» — и музыка будет похожа на исходную.</p>
            <button className="btn soft" disabled={!actText.trim() || streaming} onClick={() => props.onUseText(song, actText, actTitle, actLang)}>Перейти к созданию <IcArrowRight size={15} /></button>
          </div>
          <div className="card song-action hot">
            <div className="sa-ic"><IcDisc size={18} /></div>
            <h4>Новые слова на эту музыку</h4>
            <p>ACE-Step перепоёт песню с {useNew ? 'новым текстом' : 'этим текстом'}, сохраняя мелодию, аккорды и аранжировку оригинала.</p>
            <button className="btn primary" disabled={!actText.trim() || streaming} onClick={() => setRemake(true)}><IcMic size={15} /> Спеть на эту музыку</button>
          </div>
          <div className="card song-action">
            <div className="sa-ic"><IcMic size={18} /></div>
            <h4>Голос исполнителя</h4>
            <p>Сохранить голос из этой песни как голосовую модель. Одной песни хватит для начала, для сходства лучше 3–5.</p>
            <button className="btn" disabled={!song.paths.vocals} onClick={() => setVoiceDlg(true)}><IcPlus size={15} /> Сохранить голос</button>
          </div>
          <div className="card song-action">
            <div className="sa-ic"><IcWave size={18} /></div>
            <h4>Стиль</h4>
            {song.caption
              ? <p className="caption">{song.caption}</p>
              : <p>ACE-Step может описать стиль песни — это описание пойдёт в «новые слова на эту музыку».</p>}
            <button className="btn sm" disabled={!!busy} onClick={analyzeStyle}>{busy === 'style' ? <><span className="spin" /> Слушаем песню…</> : song.caption ? 'Определить заново' : 'Определить стиль'}</button>
          </div>
        </div>
      </div>

      {remake && <RemakeDialog song={song} voices={props.voices} initialSource={useNew ? 'new' : 'orig'} onClose={() => setRemake(false)}
        onStarted={() => { setRemake(false); props.onJobStarted(); }} />}
      {voiceDlg && song.paths.vocals && (
        <NewVoiceDialog
          initial={{ name: song.title.slice(0, 30), gender: song.gender ?? 'male', sources: [{ path: song.paths.vocals, kind: 'clean' }],
            note: 'Вокал уже отделён от музыки. Добавьте другие песни того же исполнителя — сходство будет заметно лучше.' }}
          onClose={() => setVoiceDlg(false)}
          onStarted={() => { setVoiceDlg(false); props.onVoiceStarted(); }} />
      )}
    </div>
  );
}

function Timeline({ song }: { song: SongItem }) {
  const d = Math.max(1, song.duration);
  const marks = [];
  const step = d > 240 ? 60 : 30;
  for (let t = 0; t <= d; t += step) marks.push(t);
  return (
    <div className="card timeline-card">
      <div className="timeline">
        {song.sections.map((s, i) => (
          <div key={i} className={`tl-seg ${sectionClass(s)}`} style={{ left: `${(s.start / d) * 100}%`, width: `${Math.max(0.6, ((s.end - s.start) / d) * 100)}%` }}
            title={`${ru(s.tag)} · ${fmtTime(s.start)}–${fmtTime(s.end)}${s.lines.length ? ` · ${s.lines.length} строк` : ''}`}>
            <span>{ru(s.tag)}</span>
          </div>
        ))}
      </div>
      <div className="tl-scale">{marks.map((t) => <span key={t} style={{ left: `${(t / d) * 100}%` }}>{fmtTime(t)}</span>)}</div>
    </div>
  );
}
