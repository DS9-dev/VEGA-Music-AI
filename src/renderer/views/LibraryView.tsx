import { useEffect, useMemo, useState } from 'react';
import { fmtTime } from '../../shared/lyrics';
import type { Track, VoiceItem } from '../../shared/types';
import { usePlayer } from '../components/Player';
import { Cover, useToast } from '../components/ui';
import { RevoiceDialog } from '../components/VoiceDialogs';
import { IcFolder, IcLibrary, IcMic, IcPause, IcPlay, IcRepeat, IcSearch, IcSparkles, IcStar, IcStarFill, IcText, IcTrash } from '../icons';

export function LibraryView(props: { refreshKey: number; onReuse: (t: Track) => void; onCreate: () => void; voices: VoiceItem[]; onJobStarted: () => void }) {
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [q, setQ] = useState('');
  const [openLyrics, setOpenLyrics] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [revoice, setRevoice] = useState<Track | null>(null);
  const player = usePlayer();
  const toast = useToast();

  const load = () => window.api.library.list().then(setTracks).catch((e) => { toast('err', String(e.message ?? e)); setTracks([]); });
  useEffect(() => { void load(); }, [props.refreshKey]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!tracks) return [];
    if (!s) return tracks;
    return tracks.filter((t) => [t.title, t.params.theme, t.params.genres.join(' '), t.lyrics].join(' ').toLowerCase().includes(s));
  }, [tracks, q]);

  const toggleFav = async (t: Track, i: number) => {
    const variants = t.variants.map((v, j) => (j === i ? { ...v, favorite: !v.favorite } : v));
    const upd = await window.api.library.update(t.id, { variants });
    setTracks((x) => x?.map((y) => (y.id === t.id ? upd : y)) ?? null);
  };

  const remove = async (t: Track) => {
    if (confirmDel !== t.id) { setConfirmDel(t.id); setTimeout(() => setConfirmDel((c) => (c === t.id ? null : c)), 3000); return; }
    await window.api.library.remove(t.id);
    toast('ok', `«${t.title}» перемещён в корзину`);
    setTracks((x) => x?.filter((y) => y.id !== t.id) ?? null);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Библиотека</h1>
          <p className="page-sub">{tracks ? `${tracks.length} ${plural(tracks.length, 'трек', 'трека', 'треков')}` : 'Загрузка…'}</p>
        </div>
        <div className="page-actions">
          <div className="search"><IcSearch size={15} /><input className="input" placeholder="Поиск по названию, жанру, тексту" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <button className="btn" onClick={() => window.api.library.openRoot()}><IcFolder size={16} /> Папка</button>
        </div>
      </div>

      {tracks && !tracks.length && (
        <div className="empty">
          <div className="big-ic"><IcLibrary size={36} /></div>
          <h3>Здесь появятся ваши треки</h3>
          <p>Создайте первый — это займёт пару минут.</p>
          <button className="btn primary" onClick={props.onCreate}><IcSparkles size={16} /> Создать трек</button>
        </div>
      )}

      <div className="tracks">
        {filtered.map((t, idx) => {
          const playingThis = player.track?.id === t.id;
          return (
            <div key={t.id} className={`track ${playingThis ? 'playing' : ''}`} style={{ animationDelay: `${Math.min(idx, 12) * 30}ms` }}>
              <Cover title={t.title} />
              <div className="track-main">
                <div className="track-title">{t.title}</div>
                <div className="track-meta">
                  {new Date(t.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {' · '}{fmtTime(t.params.duration)} · {t.bpm} BPM · {t.params.instrumental ? 'инструментал' : t.voiceName ? `голос «${t.voiceName}»` : t.params.voice === 'male' ? 'мужской вокал' : 'женский вокал'}
                  {t.generationSeconds ? ` · создан за ${fmtTime(t.generationSeconds)}` : ''}
                </div>
                <div className="track-tags">
                  {t.params.genres.map((g) => <span key={g} className="tag">{g}</span>)}
                  {t.params.moods.map((g) => <span key={g} className="tag">{g}</span>)}
                  {t.params.matureDark && <span className="tag dark">Mature Dark</span>}
                  {t.voiceName && <span className="tag voice"><IcMic size={11} /> {t.voiceName}</span>}
                </div>
              </div>
              <div className="track-side">
                <div className="track-variants">
                  {t.variants.map((v, i) => {
                    const on = playingThis && player.variant === i;
                    return (
                      <span key={v.file} className={`vbtn ${on ? 'on' : ''} ${v.original ? 'orig' : ''}`} title={v.original ? 'Исходный вокал ACE-Step до перепевки' : undefined}>
                        <button className="pi" style={{ border: 0 }} onClick={() => (on ? player.toggle() : player.play(t, i))}>
                          {on && player.playing ? <IcPause size={11} /> : <IcPlay size={11} />}
                        </button>
                        <span onClick={() => (on ? player.toggle() : player.play(t, i))} style={{ cursor: 'pointer' }}>{v.label ?? `Вариант ${i + 1}`}</span>
                        <span className={`star ${v.favorite ? 'on' : ''}`} role="button" title="Лучший" onClick={() => toggleFav(t, i)}>
                          {v.favorite ? <IcStarFill size={14} /> : <IcStar size={14} />}
                        </span>
                      </span>
                    );
                  })}
                </div>
                <div className="track-actions">
                  <button className="btn sm ghost" title="Создать заново с этими настройками и текстом" onClick={() => props.onReuse(t)}><IcRepeat size={15} /> Повторить</button>
                  {!t.params.instrumental && <button className="btn sm ghost" title="Перепеть этот трек своим голосом" disabled={!props.voices.some((v) => v.usable)} onClick={() => setRevoice(t)}><IcMic size={15} /> Перепеть</button>}
                  <button className={`btn sm icon ghost ${openLyrics === t.id ? 'soft' : ''}`} title="Текст" onClick={() => setOpenLyrics(openLyrics === t.id ? null : t.id)}><IcText size={15} /></button>
                  <button className="btn sm icon ghost" title="Показать в папке" onClick={() => window.api.library.reveal(t.id, t.variants[0]?.file)}><IcFolder size={15} /></button>
                  <button className={`btn sm ${confirmDel === t.id ? 'danger' : 'icon ghost'}`} title="Удалить в корзину" onClick={() => remove(t)}>
                    <IcTrash size={15} />{confirmDel === t.id ? ' Точно?' : ''}
                  </button>
                </div>
              </div>
              {openLyrics === t.id && (
                <div className="track-lyrics">
                  <div className="dim" style={{ marginBottom: 8, fontSize: 12 }}>Стиль: {t.caption}</div>
                  {t.lyrics}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {revoice && <RevoiceDialog track={revoice} voices={props.voices} onClose={() => setRevoice(null)} onStarted={() => { setRevoice(null); props.onJobStarted(); }} />}
    </>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
