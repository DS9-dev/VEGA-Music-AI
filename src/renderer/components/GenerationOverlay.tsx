import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '../../shared/lyrics';
import type { JobState } from '../../shared/types';
import { IcCheck, IcLibrary, IcMinimize, IcPlay, IcRepeat, IcX } from '../icons';
import { Visualizer } from './Visualizer';

const STEPS = ['Подготовка', 'Композиция', 'Синтез', 'Сохранение'];

/** Плавно догоняющее значение — прогресс не «прыгает», а течёт. */
function useSmooth(target: number) {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      cur.current += (target - cur.current) * 0.08;
      if (Math.abs(target - cur.current) < 0.0005) cur.current = target;
      setV(cur.current);
      if (cur.current !== target) raf = requestAnimationFrame(tick);
    };
    if (target < cur.current) { cur.current = target; setV(target); } else raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

/** Локальный секундомер между обновлениями из main-процесса. */
function useTicker(job: JobState) {
  const [now, setNow] = useState(Date.now());
  const base = useRef({ at: Date.now(), elapsed: job.elapsedSec, eta: job.etaSec });
  useEffect(() => { base.current = { at: Date.now(), elapsed: job.elapsedSec, eta: job.etaSec }; }, [job.elapsedSec, job.etaSec]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const running = ['preparing', 'starting', 'generating', 'saving'].includes(job.phase);
  const dt = running ? (now - base.current.at) / 1000 : 0;
  return {
    elapsed: base.current.elapsed + dt,
    eta: base.current.eta == null ? null : Math.max(0, base.current.eta - dt),
  };
}

export function GenerationOverlay(props: {
  job: JobState;
  onHide: () => void;
  onCancel: () => void;
  onClose: () => void;
  onOpenLibrary: () => void;
  onPlay: (variantIndex: number) => void;
  variantsCount: number;
}) {
  const { job } = props;
  const p = useSmooth(job.progress);
  const { elapsed, eta } = useTicker(job);
  const done = job.phase === 'done';
  const failed = job.phase === 'error' || job.phase === 'cancelled';
  const mode = done ? 'done' : failed ? 'error' : 'run';
  const pct = Math.floor(p * 100);

  return (
    <div className="overlay">
      <div className="gen-card">
        <div className="viz">
          <Visualizer progress={p} mode={mode} />
          <div className="viz-center">
            <div className="viz-pct">{done ? <IcCheck size={54} /> : <>{pct}<small>%</small></>}</div>
          </div>
        </div>
        <div className="gen-body">
          <div className="gen-title">
            <h2>{done ? 'Трек готов!' : failed ? (job.phase === 'cancelled' ? 'Генерация отменена' : 'Не получилось') : `Создаём «${job.title}»`}</h2>
            <div className="gen-stage">{done ? `«${job.title}»` : job.stageLabel}</div>
            <div className="gen-detail">{failed ? '' : done ? 'Сохранён в библиотеку' : job.detail}</div>
          </div>

          <div className={`progress ${done ? 'done' : ''} ${failed ? 'error' : ''}`}>
            <div className="progress-fill" style={{ width: `${Math.max(2, p * 100)}%` }} />
          </div>
          <div className="gen-stats">
            <span>Прошло <b>{fmtTime(elapsed)}</b></span>
            <span>{done ? <>Готово за <b>{fmtTime(job.elapsedSec)}</b></> : failed ? '' : eta != null ? <>Осталось примерно <b>{fmtTime(eta)}</b></> : job.phase === 'starting' ? 'Запуск модели…' : 'Почти готово…'}</span>
          </div>

          <div className="steps">
            {STEPS.map((s, i) => {
              const state = done || i < job.step ? 'done' : i === job.step && !failed ? 'active' : '';
              return (
                <div key={s} className={`step ${state}`}>
                  <span className="s-ic">{state === 'done' ? <IcCheck size={12} /> : i + 1}</span>{s}
                </div>
              );
            })}
          </div>

          {failed && job.error && <div className="gen-error">{job.error}</div>}

          {done && (
            <div className="variants">
              {Array.from({ length: props.variantsCount }, (_, i) => (
                <button key={i} className="btn soft" onClick={() => props.onPlay(i)}><IcPlay size={14} /> Вариант {i + 1}</button>
              ))}
            </div>
          )}

          <div className="gen-actions">
            {!done && !failed && <>
              <button className="btn" onClick={props.onHide}><IcMinimize size={16} /> Свернуть</button>
              <button className="btn ghost danger" onClick={props.onCancel} title="Результат не сохранится. ACE-Step может дорабатывать задачу в фоне ещё немного."><IcX size={16} /> Отменить</button>
            </>}
            {done && <>
              <button className="btn primary" onClick={props.onOpenLibrary}><IcLibrary size={16} /> Открыть в библиотеке</button>
              <button className="btn" onClick={props.onClose}><IcRepeat size={16} /> Создать ещё</button>
            </>}
            {failed && <button className="btn" onClick={props.onClose}>Закрыть</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
