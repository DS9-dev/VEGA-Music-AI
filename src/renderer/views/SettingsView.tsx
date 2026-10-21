import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackendStatus, LmModelInfo, Settings } from '../../shared/types';
import { Switch, useToast } from '../components/ui';
import { IcFolder, IcRefresh } from '../icons';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="label">{label}{hint && <small>{hint}</small>}</div>
      <div>{children}</div>
    </div>
  );
}

export function SettingsView({ status }: { status: BackendStatus }) {
  const [s, setS] = useState<Settings | null>(null);
  const [models, setModels] = useState<LmModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const toast = useToast();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<Settings>>({});

  useEffect(() => { void window.api.settings.get().then(setS); }, []);
  const loadModels = async () => {
    setLoadingModels(true);
    try { setModels(await window.api.lm.models()); } catch (e) { toast('err', String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setLoadingModels(false); }
  };
  useEffect(() => { if (status.lm === 'online') void loadModels(); }, [status.lm]);

  if (!s) return null;
  const upd = (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    setS(next);
    Object.assign(pending.current, patch);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const all = pending.current; pending.current = {};
      void window.api.settings.set(all).then(() => toast('ok', 'Сохранено'));
    }, 500);
  };
  const pick = async (key: 'aceRuntimePath' | 'libraryPath') => {
    const r = await window.api.settings.pickFolder(s[key]);
    if (r) upd({ [key]: r } as Partial<Settings>);
  };
  const modelOptions = models.some((m) => m.key === s.lyricsModel) ? models : [{ key: s.lyricsModel, name: s.lyricsModel, loaded: false }, ...models];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Настройки</h1>
          <p className="page-sub">Сохраняются автоматически</p>
        </div>
      </div>
      <div className="settings">
        <div className="card">
          <div className="card-title">Текст песни · LM Studio</div>
          <Row label="Адрес сервера" hint="LM Studio → Developer → Start Server">
            <input className="input" value={s.lmEndpoint} onChange={(e) => upd({ lmEndpoint: e.target.value })} />
          </Row>
          <Row label="Модель" hint="Любая загруженная в LM Studio">
            <div className="row">
              <select className="select" value={s.lyricsModel} onChange={(e) => upd({ lyricsModel: e.target.value })}>
                {modelOptions.map((m) => <option key={m.key} value={m.key}>{m.name}{m.loaded ? ' · загружена' : ''}</option>)}
              </select>
              <button className="btn icon" title="Обновить список" onClick={loadModels}><IcRefresh size={16} className={loadingModels ? 'spin' : ''} /></button>
            </div>
          </Row>
          <Row label="Креативность" hint={`temperature ${s.lyricsTemperature.toFixed(2)}`}>
            <input className="range" type="range" min={0.3} max={1.3} step={0.05} value={s.lyricsTemperature}
              style={{ ['--p' as string]: `${((s.lyricsTemperature - 0.3) / 1) * 100}%` }} onChange={(e) => upd({ lyricsTemperature: Number(e.target.value) })} />
          </Row>
          <Row label="Выгружать модель" hint="Освобождать видеопамять перед созданием трека">
            <span onClick={() => upd({ unloadLyricsModel: !s.unloadLyricsModel })} style={{ cursor: 'pointer' }}><Switch on={s.unloadLyricsModel} /></span>
          </Row>
        </div>

        <div className="card">
          <div className="card-title">Музыка · ACE-Step 1.5</div>
          <Row label="Адрес API"><input className="input" value={s.aceEndpoint} onChange={(e) => upd({ aceEndpoint: e.target.value })} /></Row>
          <Row label="Папка ACE-Step" hint="Где лежит .venv\Scripts\acestep-api.exe">
            <div className="row">
              <input className="input" value={s.aceRuntimePath} onChange={(e) => upd({ aceRuntimePath: e.target.value })} />
              <button className="btn icon" onClick={() => pick('aceRuntimePath')}><IcFolder size={16} /></button>
            </div>
          </Row>
          <Row label="Автозапуск" hint="Запускать ACE-Step, если он не запущен">
            <span onClick={() => upd({ aceAutoStart: !s.aceAutoStart })} style={{ cursor: 'pointer' }}><Switch on={s.aceAutoStart} /></span>
          </Row>
          <Row label="Останавливать при выходе" hint="Только если VEGA-Music-AI сам его запустил">
            <span onClick={() => upd({ aceStopOnExit: !s.aceStopOnExit })} style={{ cursor: 'pointer' }}><Switch on={s.aceStopOnExit} /></span>
          </Row>
          <Row label="Модель DiT">
            <select className="select" value={s.aceModel} onChange={(e) => upd({ aceModel: e.target.value })}>
              <option value="acestep-v15-turbo">acestep-v15-turbo (быстро)</option>
              <option value="acestep-v15-base">acestep-v15-base (медленнее)</option>
            </select>
          </Row>
          <Row label="Шаги диффузии" hint="turbo: 8, base: 32–64">
            <input className="input" type="number" min={1} max={200} value={s.aceInferenceSteps} onChange={(e) => upd({ aceInferenceSteps: Number(e.target.value) || 8 })} />
          </Row>
          <Row label="Температура LM" hint="Ниже — стабильнее, выше — разнообразнее">
            <input className="input" type="number" min={0.1} max={1.5} step={0.05} value={s.aceLmTemperature} onChange={(e) => upd({ aceLmTemperature: Number(e.target.value) || 0.85 })} />
          </Row>
          <Row label="Формат файлов">
            <select className="select" value={s.audioFormat} onChange={(e) => upd({ audioFormat: e.target.value as Settings['audioFormat'] })}>
              <option value="mp3">MP3</option><option value="wav">WAV</option><option value="flac">FLAC</option>
            </select>
          </Row>
        </div>

        <div className="card">
          <div className="card-title">Библиотека</div>
          <Row label="Папка треков">
            <div className="row">
              <input className="input" value={s.libraryPath} onChange={(e) => upd({ libraryPath: e.target.value })} />
              <button className="btn icon" onClick={() => pick('libraryPath')}><IcFolder size={16} /></button>
            </div>
          </Row>
          <Row label="Оценка времени" hint={`1 вар.: ${s.calibration['1']} с/с · 2 вар.: ${s.calibration['2']} с/с — подстраивается сама`}>
            <button className="btn sm" onClick={() => upd({ calibration: { '1': 0.55, '2': 0.72, overhead: 12 } })}>Сбросить калибровку</button>
          </Row>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={async () => { setS(await window.api.settings.reset()); toast('ok', 'Настройки сброшены'); }}>Сбросить все настройки</button>
        </div>
      </div>
    </>
  );
}
