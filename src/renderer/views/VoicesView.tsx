import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '../../shared/lyrics';
import type { JobState, VoiceCheck, VoiceItem, VoiceTrainProfile } from '../../shared/types';
import { useToast } from '../components/ui';
import { NewVoiceDialog, PROFILES, RevoiceDialog } from '../components/VoiceDialogs';
import { IcAlert, IcDownload, IcEdit, IcFemale, IcFolder, IcMale, IcMic, IcPause, IcPlay, IcPlus, IcRefresh, IcSparkles, IcTrash, IcUpload } from '../icons';

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
let checkCache: VoiceCheck | null = null;

function hue(name: string) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }

export function VoicesView(props: {
  voices: VoiceItem[];
  refresh: () => void;
  job: JobState | null;
  onJobStarted: () => void;
  onUse: (v: VoiceItem) => void;
  onSettings: () => void;
}) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [revoice, setRevoice] = useState<VoiceItem | null>(null);
  const [check, setCheck] = useState<VoiceCheck | null>(checkCache);
  const [playing, setPlaying] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [retrainFor, setRetrainFor] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(new Audio());

  useEffect(() => {
    if (!checkCache) void window.api.voices.check().then((c) => { checkCache = c; setCheck(c); }).catch((e) => setCheck({ ok: false, problems: [errText(e)], cuda: null }));
    const a = audio.current;
    const end = () => setPlaying(null);
    a.addEventListener('ended', end);
    return () => { a.pause(); a.removeEventListener('ended', end); };
  }, []);

  const play = async (v: VoiceItem) => {
    const a = audio.current;
    if (playing === v.id) { a.pause(); setPlaying(null); return; }
    try {
      const raw = await window.api.voices.readAudio(v.id);
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array((raw as Uint8Array).buffer, (raw as Uint8Array).byteOffset, (raw as Uint8Array).byteLength);
      a.src = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'audio/wav' }));
      await a.play();
      setPlaying(v.id);
    } catch (e) { toast('err', errText(e)); }
  };

  const remove = async (v: VoiceItem) => {
    if (confirmDel !== v.id) { setConfirmDel(v.id); setTimeout(() => setConfirmDel((c) => (c === v.id ? null : c)), 3000); return; }
    await window.api.voices.remove(v.id);
    toast('ok', `Голос «${v.name}» перемещён в корзину`);
    props.refresh();
  };

  const exportVoice = async (v: VoiceItem) => {
    try {
      const f = await window.api.voices.exportVoice(v.id);
      if (f) toast('ok', `Голос сохранён: ${f.split(/[\\/]/).pop()}`);
    } catch (e) { toast('err', errText(e)); }
  };

  const importVoice = async () => {
    try {
      const v = await window.api.voices.importVoice();
      if (v) { toast('ok', `Голос «${v.name}» добавлен`); props.refresh(); }
    } catch (e) { toast('err', errText(e)); }
  };

  const retrain = async (v: VoiceItem, profile: VoiceTrainProfile) => {
    setRetrainFor(null);
    try { await window.api.voices.retrain(v.id, profile); props.onJobStarted(); } catch (e) { toast('err', errText(e)); }
  };

  const rename = async (v: VoiceItem, name: string) => {
    setRenaming(null);
    if (name.trim() && name.trim() !== v.name) { await window.api.voices.rename(v.id, name); props.refresh(); }
  };

  const running = props.job && ['preparing', 'starting', 'generating', 'saving'].includes(props.job.phase) && props.job.kind === 'voice' ? props.job : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Голоса</h1>
          <p className="page-sub">Обучите модель на песнях — и треки будут петь этим голосом</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={importVoice} title="Открыть файл .vegavoice"><IcUpload size={16} /> Импорт</button>
          <button className="btn icon" onClick={() => window.api.voices.openRoot()} title="Папка голосов"><IcFolder size={16} /></button>
          <button className="btn primary" onClick={() => setCreating(true)}><IcPlus size={16} /> Новый голос</button>
        </div>
      </div>

      {check && !check.ok && (
        <div className="banner">
          <IcAlert size={18} />
          <div style={{ flex: 1 }}>
            <b>Не все компоненты для голосов найдены</b>
            <ul>{check.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
          <button className="btn sm" onClick={props.onSettings}>Настройки</button>
          <button className="btn sm icon ghost" title="Проверить снова" onClick={() => { checkCache = null; setCheck(null); void window.api.voices.check().then((c) => { checkCache = c; setCheck(c); }); }}><IcRefresh size={14} /></button>
        </div>
      )}

      {props.voices.length === 0 && (
        <div className="empty">
          <div className="big-ic"><IcMic size={36} /></div>
          <h3>Создайте свой голос</h3>
          <p>Загрузите песни — VEGA-Music-AI выделит вокал и обучит модель голоса.</p>
          <div className="how">
            <div><span className="n">1</span><b>Песни</b>3–5 песен одного исполнителя. Музыка не мешает — вокал выделится сам.</div>
            <div><span className="n">2</span><b>Обучение</b>Seed-VC дообучается на фразах голоса: от 5 до 30 минут.</div>
            <div><span className="n">3</span><b>Пение</b>Выберите голос при создании трека или перепойте готовый трек.</div>
          </div>
          <button className="btn primary big" onClick={() => setCreating(true)}><IcPlus size={18} /> Новый голос</button>
        </div>
      )}

      <div className="voices-grid">
        {props.voices.map((v, idx) => {
          const job = running && running.targetId === v.id ? running : null;
          const h = hue(v.name);
          const st = v.status === 'error' ? { c: 'err', t: 'Ошибка' } : job || v.status === 'training' || v.status === 'preparing'
            ? { c: 'run', t: job ? `${v.status === 'preparing' ? 'Подготовка' : 'Обучение'} ${Math.floor(job.progress * 100)}%` : 'Прервано' }
            : v.checkpoint ? { c: 'ok', t: 'Обучен' } : { c: 'zero', t: 'Без обучения' };
          return (
            <div key={v.id} className={`voice-card ${job ? 'training' : ''}`} style={{ animationDelay: `${Math.min(idx, 10) * 30}ms` }}>
              <div className="voice-head">
                <div className={`voice-avatar ${job ? 'pulse' : ''}`} style={{ background: `radial-gradient(circle at 30% 25%, hsl(${h} 85% 65%), hsl(${(h + 60) % 360} 70% 40%))` }}>
                  {v.gender === 'female' ? <IcFemale size={22} /> : <IcMale size={22} />}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {renaming === v.id
                    ? <input className="voice-name-input" defaultValue={v.name} autoFocus onBlur={(e) => rename(v, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                    : <div className="voice-name" onDoubleClick={() => setRenaming(v.id)} title="Двойной щелчок — переименовать">{v.name}</div>}
                  <div className="voice-sub">{v.gender === 'female' ? 'Женский' : 'Мужской'}{v.note ? ` · средняя нота ${v.note}` : ''} · {new Date(v.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</div>
                </div>
                <span className={`badge ${st.c}`}>{st.t}</span>
              </div>

              {job && (
                <div>
                  <div className="mini-progress"><i style={{ width: `${Math.max(3, job.progress * 100)}%` }} /></div>
                  <div className="voice-sub" style={{ marginTop: 6 }}>{job.stageLabel} · {job.detail}{job.etaSec ? ` · осталось ≈ ${fmtTime(job.etaSec)}` : ''}</div>
                </div>
              )}

              <div className="voice-stats">
                <div className="stat"><b>{v.dataset ? fmtTime(v.dataset.seconds) : '—'}</b><span>чистого вокала</span></div>
                <div className="stat"><b>{v.dataset?.segments ?? '—'}</b><span>фраз</span></div>
                <div className="stat"><b>{v.training?.steps ?? 0}</b><span>шагов обучения</span></div>
              </div>

              {v.status === 'error' && v.error && <div className="voice-error">{v.error}</div>}
              {v.dataset?.warnings?.slice(0, 1).map((w) => <div key={w} className="voice-warn"><IcAlert size={14} />{w}</div>)}

              {retrainFor === v.id && (
                <div className="profiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  {PROFILES.filter((p) => p.id !== 'zero').map((p) => (
                    <button key={p.id} className="profile" onClick={() => retrain(v, p.id)}><b>{p.title}</b><span>{p.desc}</span></button>
                  ))}
                </div>
              )}

              <div className="voice-actions">
                <button className={`btn sm icon ${playing === v.id ? 'soft' : ''}`} disabled={!v.reference} onClick={() => play(v)} title="Послушать образец голоса">
                  {playing === v.id ? <IcPause size={13} /> : <IcPlay size={13} />}
                </button>
                <button className="btn sm soft" disabled={!v.usable} onClick={() => props.onUse(v)}><IcSparkles size={14} /> Создать трек</button>
                <button className="btn sm" disabled={!v.usable || !!running} onClick={() => setRevoice(v)}><IcMic size={14} /> Перепеть</button>
                <span style={{ flex: 1 }} />
                <button className="btn sm icon ghost" title="Дообучить" disabled={!v.dataset || !!running} onClick={() => setRetrainFor(retrainFor === v.id ? null : v.id)}><IcRefresh size={14} /></button>
                <button className="btn sm icon ghost" title="Переименовать" onClick={() => setRenaming(v.id)}><IcEdit size={14} /></button>
                <button className="btn sm icon ghost" title="Экспорт в файл .vegavoice" disabled={!v.usable} onClick={() => exportVoice(v)}><IcDownload size={14} /></button>
                <button className="btn sm icon ghost" title="Показать в папке" onClick={() => window.api.voices.reveal(v.id)}><IcFolder size={14} /></button>
                <button className={`btn sm ${confirmDel === v.id ? 'danger' : 'icon ghost'}`} title="Удалить в корзину" disabled={!!job} onClick={() => remove(v)}>
                  <IcTrash size={14} />{confirmDel === v.id ? ' Точно?' : ''}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {creating && <NewVoiceDialog onClose={() => setCreating(false)} onStarted={() => { setCreating(false); props.refresh(); props.onJobStarted(); }} />}
      {revoice && <RevoiceDialog voice={revoice} voices={props.voices} onClose={() => setRevoice(null)} onStarted={() => { setRevoice(null); props.onJobStarted(); }} />}
    </>
  );
}
