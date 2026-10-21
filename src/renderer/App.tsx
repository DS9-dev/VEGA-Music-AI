import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PARAMS } from '../shared/catalog';
import type { BackendStatus, JobState, Track, TrackParams } from '../shared/types';
import { GenerationOverlay } from './components/GenerationOverlay';
import { PlayerBar, usePlayer } from './components/Player';
import { useToast } from './components/ui';
import { IcLibrary, IcLogo, IcMinimize, IcSettings, IcSparkles, IcX } from './icons';
import { CreateView, type Draft } from './views/CreateView';
import { LibraryView } from './views/LibraryView';
import { SettingsView } from './views/SettingsView';

type View = 'create' | 'library' | 'settings';

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? { ...fallback, ...JSON.parse(v) } : fallback; } catch { return fallback; }
}
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* нет хранилища */ } }

const RUNNING = ['preparing', 'starting', 'generating', 'saving'];
const BUILD_LABEL = new Date(__BUILD_TIME__).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function App() {
  const [view, setView] = useState<View>('create');
  const [params, setParams] = useState<TrackParams>(() => load('mb.params', DEFAULT_PARAMS));
  const [draft, setDraft] = useState<Draft>(() => load('mb.draft', { title: '', text: '' }));
  const [status, setStatus] = useState<BackendStatus>({ ace: 'offline', aceOwned: false, lm: 'offline' });
  const [job, setJob] = useState<JobState | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [libKey, setLibKey] = useState(0);
  const [lastTrack, setLastTrack] = useState<Track | null>(null);
  const player = usePlayer();
  const toast = useToast();
  const jobRef = useRef<JobState | null>(null);

  useEffect(() => save('mb.params', params), [params]);
  useEffect(() => { const t = setTimeout(() => save('mb.draft', draft), 300); return () => clearTimeout(t); }, [draft]);

  // статус бэкендов
  useEffect(() => {
    let alive = true;
    const poll = async () => { try { const s = await window.api.status(); if (alive) setStatus(s); } catch { /* ignore */ } };
    void poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // состояние генерации
  useEffect(() => {
    void window.api.job.get().then((s) => { if (s.phase !== 'idle') { setJob(s); jobRef.current = s; } });
    return window.api.job.onUpdate(async (s) => {
      const prev = jobRef.current;
      jobRef.current = s;
      setJob(s);
      if (s.phase === 'done' && prev?.phase !== 'done') {
        setLibKey((k) => k + 1);
        const list = await window.api.library.list();
        setLastTrack(list.find((t) => t.id === s.trackId) ?? null);
      }
    });
  }, []);

  const busy = !!job && RUNNING.includes(job.phase);

  const create = async () => {
    try {
      setLastTrack(null);
      await window.api.job.start(params, draft.title.trim() || 'Без названия', draft.text);
      setOverlay(true);
    } catch (e) { toast('err', String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };

  const closeJob = async () => { setOverlay(false); await window.api.job.reset(); setJob(null); jobRef.current = null; };

  const reuse = (t: Track) => {
    setParams({ ...DEFAULT_PARAMS, ...t.params });
    setDraft({ title: t.title, text: t.lyrics === '[Instrumental]' ? '' : t.lyrics });
    setView('create');
    toast('ok', 'Настройки и текст загружены');
  };

  const showOverlay = overlay && !!job && job.phase !== 'idle' && view === 'create';
  const mac = window.api.platform === 'darwin';

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo"><IcLogo size={17} color="white" /></div>
          <div><div className="brand-name">VEGA-Music-AI</div><div className="brand-ver" title={`Сборка ${BUILD_LABEL}`}>v{__APP_VERSION__} · {BUILD_LABEL}</div></div>
        </div>
        <button className={`nav-item ${view === 'create' ? 'active' : ''}`} onClick={() => setView('create')}><IcSparkles size={17} /> Создать</button>
        <button className={`nav-item ${view === 'library' ? 'active' : ''}`} onClick={() => setView('library')}><IcLibrary size={17} /> Библиотека</button>
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}><IcSettings size={17} /> Настройки</button>

        {job && job.phase !== 'idle' && !showOverlay && (
          <button className="mini-job" onClick={() => { setView('create'); setOverlay(true); }}>
            <ProgressRing value={job.progress} done={job.phase === 'done'} error={job.phase === 'error' || job.phase === 'cancelled'} />
            <div className="mini-job-text">
              <div className="mini-job-title">{job.title}</div>
              <div className="mini-job-sub">{job.phase === 'done' ? 'Готово — открыть' : job.phase === 'error' ? 'Ошибка' : `${job.stageLabel} · ${Math.floor(job.progress * 100)}%`}</div>
            </div>
          </button>
        )}

        <div className="sidebar-spacer" />
        <div className="status-card">
          <div className="status-row"><span className={`dot ${status.ace}`} /><b>ACE-Step</b>
            {status.ace === 'offline' && <button className="link" onClick={() => { void window.api.ace.start().catch((e) => toast('err', String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))); setStatus({ ...status, ace: 'starting' }); }}>Запустить</button>}
            {status.ace === 'starting' && <span style={{ marginLeft: 'auto', fontSize: 11.5 }}>запуск…</span>}
          </div>
          <div className="status-row"><span className={`dot ${status.lm}`} /><b>LM Studio</b>
            {status.lm === 'offline' && <span style={{ marginLeft: 'auto', fontSize: 11.5 }} className="dim">не запущен</span>}
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="titlebar">
          {!mac && (
            <div className="lights">
              <button className="light close" onClick={() => window.api.win.close()} aria-label="Закрыть"><IcX size={8} strokeWidth={4} color="#4a0002" /></button>
              <button className="light min" onClick={() => window.api.win.minimize()} aria-label="Свернуть"><IcMinimize size={8} strokeWidth={4} color="#5a3a00" /></button>
              <button className="light max" onClick={() => window.api.win.maximize()} aria-label="Развернуть"><svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 3V1h2M7 5v2H5" stroke="#00400a" strokeWidth="1.6" fill="none" /></svg></button>
            </div>
          )}
          <div className="titlebar-title">{view === 'create' ? 'Новый трек' : view === 'library' ? 'Библиотека' : 'Настройки'}</div>
        </div>
        <div className={`content ${player.track ? 'with-player' : ''}`}>
          {view === 'create' && (
            <CreateView params={params} setParams={setParams} draft={draft} setDraft={setDraft} status={status} busy={busy} onCreate={create} />
          )}
          {view === 'library' && <LibraryView refreshKey={libKey} onReuse={reuse} onCreate={() => setView('create')} />}
          {view === 'settings' && <SettingsView status={status} />}
        </div>
        {showOverlay && job && (
          <GenerationOverlay
            job={job}
            variantsCount={lastTrack?.variants.length ?? 0}
            onHide={() => setOverlay(false)}
            onCancel={() => void window.api.job.cancel()}
            onClose={closeJob}
            onOpenLibrary={() => { void closeJob(); setView('library'); }}
            onPlay={(i) => lastTrack && player.play(lastTrack, i)}
          />
        )}
        <PlayerBar />
      </main>
    </div>
  );
}

function ProgressRing({ value, done, error }: { value: number; done: boolean; error: boolean }) {
  const r = 14, c = 2 * Math.PI * r;
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" style={{ flex: 'none' }}>
      <defs><linearGradient id="rg" x1="0" x2="1"><stop offset="0" stopColor="#8b5cf6" /><stop offset=".55" stopColor="#ec4899" /><stop offset="1" stopColor="#f97316" /></linearGradient></defs>
      <circle cx="18" cy="18" r={r} stroke="rgba(255,255,255,.1)" strokeWidth="3.5" fill="none" />
      <circle cx="18" cy="18" r={r} stroke={error ? '#fb7185' : done ? '#34d399' : 'url(#rg)'} strokeWidth="3.5" fill="none" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - (done ? 1 : value))} transform="rotate(-90 18 18)" style={{ transition: 'stroke-dashoffset .8s ease' }} />
      {!done && !error && <circle cx="18" cy="18" r="4" fill="#ec4899"><animate attributeName="r" values="3;5;3" dur="1.4s" repeatCount="indefinite" /></circle>}
    </svg>
  );
}
