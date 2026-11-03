import { useEffect, useState, type ReactNode } from 'react';
import { fmtTime } from '../../shared/lyrics';
import type { NewVoiceSpec, Track, VoiceGender, VoiceItem, VoiceSourceKind, VoiceTrainProfile } from '../../shared/types';
import { IcFemale, IcMale, IcMic, IcMusic, IcPlus, IcX } from '../icons';
import { Cover, Segmented, useToast } from './ui';

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [props.onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" style={props.wide ? { width: 'min(760px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="btn icon ghost" onClick={props.onClose} aria-label="Закрыть"><IcX size={16} /></button>
        </div>
        <div className="modal-body">{props.children}</div>
        <div className="modal-foot">{props.footer}</div>
      </div>
    </div>
  );
}

export const PROFILES: { id: VoiceTrainProfile; title: string; desc: string; rec?: boolean }[] = [
  { id: 'zero', title: 'Без обучения', desc: 'Сразу готов. Сходство среднее' },
  { id: 'quick', title: 'Быстро', desc: '300 шагов · ≈ 5 мин' },
  { id: 'standard', title: 'Стандарт', desc: '800 шагов · ≈ 12 мин', rec: true },
  { id: 'max', title: 'Максимум', desc: '2000 шагов · ≈ 30 мин' },
];

function base(p: string) { return p.split(/[\\/]/).pop() ?? p; }

export function NewVoiceDialog(props: {
  onClose: () => void;
  onStarted: () => void;
  initial?: { name: string; gender: VoiceGender; sources: { path: string; kind: VoiceSourceKind }[]; note?: string };
}) {
  const toast = useToast();
  const [name, setName] = useState(props.initial?.name ?? '');
  const [gender, setGender] = useState<VoiceGender>(props.initial?.gender ?? 'male');
  const [sources, setSources] = useState<{ path: string; kind: VoiceSourceKind }[]>(props.initial?.sources ?? []);
  const [profile, setProfile] = useState<VoiceTrainProfile>('standard');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const files = await window.api.voices.pickSources();
    const fresh = files.filter((f) => !sources.some((s) => s.path === f)).map((path) => ({ path, kind: 'song' as VoiceSourceKind }));
    setSources([...sources, ...fresh]);
    if (!name && fresh.length) setName(base(fresh[0].path).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 30));
  };

  const valid = name.trim() && sources.length > 0 && consent;
  const create = async () => {
    setBusy(true);
    try {
      const spec: NewVoiceSpec = { name: name.trim(), gender, sources, profile, consent };
      await window.api.voices.create(spec);
      props.onStarted();
    } catch (e) { toast('err', errText(e)); setBusy(false); }
  };

  return (
    <Modal title={props.initial ? 'Голос из песни' : 'Новый голос'} onClose={props.onClose} footer={<>
      <span className="hint">{sources.length ? `${sources.length} ${sources.length === 1 ? 'файл' : 'файла(ов)'} · вокал выделится автоматически` : 'Нужна хотя бы одна песня'}</span>
      <button className="btn ghost" onClick={props.onClose}>Отмена</button>
      <button className="btn primary" disabled={!valid || busy} onClick={create}><IcMic size={16} /> Создать голос</button>
    </>}>
      <div className="grid2">
        <div className="field">
          <div className="label">Название</div>
          <input className="input" placeholder="Например: Мой голос" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field" style={{ marginTop: 0 }}>
          <div className="label">Голос</div>
          <Segmented value={gender} onChange={setGender} options={[
            { value: 'male', label: <><IcMale size={14} /> Мужской</> },
            { value: 'female', label: <><IcFemale size={14} /> Женский</> },
          ]} />
        </div>
      </div>

      {props.initial?.note && <div className="plan-line" style={{ marginTop: 14 }}>{props.initial.note}</div>}
      <div className="field">
        <div className="label">Песни или записи голоса</div>
        <div className="src-list">
          {sources.map((s, i) => (
            <div key={s.path} className="src-row">
              <span className="fn" title={s.path}><IcMusic size={13} /> {base(s.path)}</span>
              <Segmented<VoiceSourceKind> value={s.kind} onChange={(kind) => setSources(sources.map((x, j) => (j === i ? { ...x, kind } : x)))} options={[
                { value: 'song', label: 'Песня с музыкой' }, { value: 'clean', label: 'Чистый голос' },
              ]} />
              <button className="btn sm icon ghost" onClick={() => setSources(sources.filter((_, j) => j !== i))} aria-label="Убрать"><IcX size={14} /></button>
            </div>
          ))}
          <div className="drop" role="button" onClick={add}><IcPlus size={16} /> Добавить файлы (mp3, wav, flac…)</div>
        </div>
        <div className="dim" style={{ fontSize: 12.5 }}>
          Лучше всего — 3–5 песен одного исполнителя, где голос хорошо слышен. Хватит и одной, но сходство будет слабее.
          «Чистый голос» — акапелла или запись без музыки: разделение не нужно.
        </div>
      </div>

      <div className="field">
        <div className="label">Обучение</div>
        <div className="profiles">
          {PROFILES.map((p) => (
            <button key={p.id} className={`profile ${profile === p.id ? 'on' : ''}`} onClick={() => setProfile(p.id)}>
              <b>{p.title}</b><span>{p.desc}</span>{p.rec && <span className="rec">рекомендуем</span>}
            </button>
          ))}
        </div>
      </div>

      <label className="consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>Это мой голос, или у меня есть согласие его владельца. Я не буду выдавать созданные треки за записи реального человека.</span>
      </label>
    </Modal>
  );
}

/** Перепеть трек из библиотеки выбранным голосом. Открывается из голоса (выбор трека) или из трека (выбор голоса). */
export function RevoiceDialog(props: { voice?: VoiceItem; track?: Track; voices: VoiceItem[]; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const [tracks, setTracks] = useState<Track[]>(props.track ? [props.track] : []);
  const [trackId, setTrackId] = useState(props.track?.id ?? '');
  const [variant, setVariant] = useState(0);
  const usable = props.voices.filter((v) => v.usable);
  const [voiceId, setVoiceId] = useState(props.voice?.id ?? usable[0]?.id ?? '');
  const [shift, setShift] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.track) return;
    void window.api.library.list().then((l) => {
      const vocal = l.filter((t) => !t.params.instrumental);
      setTracks(vocal);
      if (!trackId && vocal[0]) setTrackId(vocal[0].id);
    });
  }, []);

  const track = tracks.find((t) => t.id === trackId);
  // по умолчанию — исходный вокал ACE-Step: он чище уже перепетого
  useEffect(() => {
    const i = track?.variants.findIndex((v) => v.original) ?? -1;
    setVariant(i >= 0 ? i : 0);
  }, [trackId, tracks.length]);
  const start = async () => {
    setBusy(true);
    try { await window.api.voices.revoice(trackId, variant, voiceId, shift); props.onStarted(); }
    catch (e) { toast('err', errText(e)); setBusy(false); }
  };

  return (
    <Modal title="Перепеть трек голосом" onClose={props.onClose} footer={<>
      <span className="hint">Получится новый трек в библиотеке, исходный не изменится</span>
      <button className="btn ghost" onClick={props.onClose}>Отмена</button>
      <button className="btn primary" disabled={!trackId || !voiceId || busy} onClick={start}><IcMic size={16} /> Перепеть</button>
    </>}>
      {!props.track && (
        <div className="field">
          <div className="label">Трек</div>
          {tracks.length === 0 ? <div className="dim">В библиотеке пока нет треков с вокалом.</div> : (
            <div className="pick-list">
              {tracks.map((t) => (
                <button key={t.id} className={`pick ${t.id === trackId ? 'on' : ''}`} onClick={() => { setTrackId(t.id); setVariant(0); }}>
                  <Cover title={t.title} small />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{t.title}</div>
                    <div className="meta">{t.params.genres.join(', ')} · {fmtTime(t.params.duration)}{t.voiceName ? ` · ${t.voiceName}` : ''}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {track && track.variants.length > 1 && (
        <div className="field">
          <div className="label">Вариант</div>
          <Segmented<number> value={variant} onChange={setVariant}
            options={track.variants.map((v, i) => ({ value: i, label: v.label ?? `Вариант ${i + 1}` }))} />
        </div>
      )}
      {!props.voice && (
        <div className="field">
          <div className="label">Голос</div>
          {usable.length === 0 ? <div className="dim">Нет готовых голосов — создайте голос во вкладке «Голоса».</div> : (
            <select className="select" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
              {usable.map((v) => <option key={v.id} value={v.id}>{v.name}{v.checkpoint ? '' : ' (без обучения)'}</option>)}
            </select>
          )}
        </div>
      )}
      <div className="field">
        <div className="label">Тон</div>
        <ShiftPicker value={shift} onChange={setShift} />
      </div>
    </Modal>
  );
}

export function ShiftPicker({ value, onChange, compact }: { value: number | null; onChange: (v: number | null) => void; compact?: boolean }) {
  return (
    <Segmented<string> value={value == null ? 'auto' : String(value)} onChange={(v) => onChange(v === 'auto' ? null : Number(v))} options={[
      { value: 'auto', label: 'Авто' }, { value: '-12', label: compact ? '−8ва' : 'Октавой ниже' }, { value: '0', label: compact ? 'Как есть' : 'Как есть' }, { value: '12', label: compact ? '+8ва' : 'Октавой выше' },
    ]} />
  );
}
