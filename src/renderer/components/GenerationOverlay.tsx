import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '../../shared/lyrics';
import type { JobState } from '../../shared/types';
import { IcCheck, IcLibrary, IcMic, IcMinimize, IcPlay, IcRepeat, IcSparkles, IcX } from '../icons';
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
  onOpenVoices: () => void;
  onUseVoice: () => void;
  onPlay: (variantIndex: number) => void;
  variants: string[]; // подписи вариантов готового трека
}) {
  const { job } = props;
  const p = useSmooth(job.progress);
  const { elapsed, eta } = useTicker(job);
  const done = job.phase === 'done';
  const failed = job.phase === 'error' || job.phase === 'cancelled';
  const mode = done ? 'done' : failed ? 'error' : 'run';
  const pct = Math.floor(p * 100);
  const kind = job.kind ?? 'track';
  const steps = job.steps ?? STEPS;
  const title = done
    ? { track: 'Трек готов!', voice: 'Голос готов!', revoice: 'Трек перепет!' }[kind]
    : failed
      ? (job.phase === 'cancelled' ? 'Отменено' : 'Не получилось')
      : { track: `Создаём «${job.title}»`, voice: `Обучаем голос «${job.title}»`, revoice: `Перепеваем «${job.title}»` }[kind];
  const doneDetail = kind === 'voice' ? job.detail : 'Сохранён в библиотеку';
  const cancelHint = kind === 'track' ? 'Результат не сохранится. ACE-Step может дорабатывать задачу в фоне ещё немного.'
    : kind === 'voice' ? 'Если фразы уже нарезаны, голос останется доступным без обучения.' : 'Результат не сохранится.';

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
            <h2>{title}</h2>
            <div className="gen-stage">{done ? `«${job.title}»` : job.stageLabel}</div>
            <div className="gen-detail">{failed ? '' : done ? doneDetail : job.detail}</div>
          </div>

          <div className={`progress ${done ? 'done' : ''} ${failed ? 'error' : ''}`}>
            <div className="progress-fill" style={{ width: `${Math.max(2, p * 100)}%` }} />
          </div>
          <div className="gen-stats">
            <span>Прошло <b>{fmtTime(elapsed)}</b></span>
            <span>{done ? <>Готово за <b>{fmtTime(job.elapsedSec)}</b></> : failed ? '' : eta != null ? <>Осталось примерно <b>{fmtTime(eta)}</b></> : job.phase === 'starting' ? 'Запуск модели…' : 'Почти готово…'}</span>
          </div>

          <div className="steps" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
            {steps.map((s, i) => {
              const state = done || i < job.step ? 'done' : i === job.step && !failed ? 'active' : '';
              return (
                <div key={s} className={`step ${state}`}>
                  <span className="s-ic">{state === 'done' ? <IcCheck size={12} /> : i + 1}</span>{s}
                </div>
              );
            })}
          </div>

          {failed && job.error && <div className="gen-error">{job.error}</div>}

          {done && kind !== 'voice' && props.variants.length > 0 && (
            <div className="variants">
              {props.variants.map((label, i) => (
                <button key={i} className="btn soft" onClick={() => props.onPlay(i)}><IcPlay size={14} /> {label}</button>
              ))}
            </div>
          )}

          <div className="gen-actions">
            {!done && !failed && <>
              <button className="btn" onClick={props.onHide}><IcMinimize size={16} /> Свернуть</button>
              <button className="btn ghost danger" onClick={props.onCancel} title={cancelHint}><IcX size={16} /> Отменить</button>
            </>}
            {done && kind === 'voice' && <>
              <button className="btn primary" onClick={props.onUseVoice}><IcSparkles size={16} /> Создать трек этим голосом</button>
              <button className="btn" onClick={props.onOpenVoices}><IcMic size={16} /> К голосам</button>
            </>}
            {done && kind !== 'voice' && <>
              <button className="btn primary" onClick={props.onOpenLibrary}><IcLibrary size={16} /> Открыть в библиотеке</button>
              <button className="btn" onClick={props.onClose}>{kind === 'track' ? <><IcRepeat size={16} /> Создать ещё</> : 'Закрыть'}</button>
            </>}
            {failed && job.trackId && <button className="btn primary" onClick={props.onOpenLibrary}><IcLibrary size={16} /> Открыть в библиотеке</button>}
            {failed && <button className="btn" onClick={props.onClose}>Закрыть</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
