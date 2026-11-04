import { useEffect, useState } from 'react';
import { LANGUAGES } from '../../shared/catalog';
import { fmtTime } from '../../shared/lyrics';
import { detectLanguage } from '../../shared/song';
import type { RemakeMethod, SongItem, VoiceCheck, VoiceItem } from '../../shared/types';
import { IcAlert, IcDisc, IcMic, IcMusic } from '../icons';
import { Range, Segmented, ToggleRow, useToast } from './ui';
import { Modal, ShiftPicker } from './VoiceDialogs';

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Загрузка песни: язык, исправление текста моделью, напоминание о правах. */
export function ImportDialog(props: { path: string; lmOnline: boolean; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const [language, setLanguage] = useState('auto');
  const [cleanup, setCleanup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<VoiceCheck | null>(null);
  useEffect(() => { void window.api.voices.check().then(setCheck).catch(() => {}); }, []);

  const start = async () => {
    setBusy(true);
    try {
      await window.api.songs.importSong({ path: props.path, language: language === 'auto' ? null : language, cleanup });
      props.onStarted();
    } catch (e) { toast('err', errText(e)); setBusy(false); }
  };

  return (
    <Modal title="Разобрать песню" onClose={props.onClose} footer={<>
      <span className="hint">Обычно 1–3 минуты: вокал, слова, темп и структура</span>
      <button className="btn ghost" onClick={props.onClose}>Отмена</button>
      <button className="btn primary" disabled={busy} onClick={start}><IcDisc size={16} /> Разобрать</button>
    </>}>
      <div className="src-row" style={{ marginBottom: 4 }}><span className="fn" title={props.path}><IcMusic size={13} /> {base(props.path)}</span></div>
      {check && check.asr === null && (
        <div className="banner" style={{ margin: '12px 0 0' }}>
          <IcAlert size={18} />
          <div>
            <b>Не установлен модуль распознавания слов</b>
            <div className="dim" style={{ marginTop: 4 }}>Выполните в папке Seed-VC: <code>.venv\Scripts\pip install faster-whisper</code>. Без него текст придётся вписать вручную.</div>
          </div>
        </div>
      )}
      {check && !check.ok && check.asr !== null && (
        <div className="banner" style={{ margin: '12px 0 0' }}><IcAlert size={18} /><div>Не все компоненты найдены: {check.problems[0]}</div></div>
      )}
      <div className="grid2" style={{ marginTop: 6 }}>
        <div className="field">
          <div className="label">Язык песни</div>
          <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="auto">Определить автоматически</option>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
        <div className="field" style={{ marginTop: 0, alignSelf: 'end' }}>
          <div className="dim" style={{ fontSize: 12.5 }}>Если язык известен — укажите: распознавание будет точнее.</div>
        </div>
      </div>
      <div className="field">
        <ToggleRow on={cleanup} onChange={setCleanup}
          title="Исправить текст моделью"
          desc={props.lmOnline ? 'Qwen поправит ослышки по смыслу и рифме и разметит куплеты и припевы' : 'LM Studio не запущен — текст останется как распознан'} />
      </div>
      <div className="plan-line" style={{ marginTop: 14 }}>
        Текст и музыка чужих песен принадлежат правообладателям. Результат подходит для личного использования;
        публиковать переделки можно только с разрешения авторов.
      </div>
    </Modal>
  );
}

const METHODS: { id: RemakeMethod; title: string; desc: string; badge?: string }[] = [
  { id: 'cover', title: 'Ремейк с новыми словами', desc: 'ACE-Step перепевает всю песню с новым текстом, сохраняя мелодию, аккорды, ритм и аранжировку оригинала. Работает на turbo-модели.', badge: 'рекомендуем' },
  { id: 'lego', title: 'Вокал поверх минуса', desc: 'Новый вокал генерируется под родной минус песни. Нужна base-модель ACE-Step (≈ 10 ГБ), дольше и капризнее.' },
];

/** «Новые слова на эту музыку»: текст, способ, голос. */
export function RemakeDialog(props: {
  song: SongItem;
  voices: VoiceItem[];
  initialSource: 'new' | 'orig';
  onClose: () => void;
  onStarted: () => void;
}) {
  const toast = useToast();
  const { song } = props;
  const hasNew = !!song.rewrite?.text.trim();
  const [source, setSource] = useState<'new' | 'orig'>(hasNew ? props.initialSource : 'orig');
  const [title, setTitle] = useState(hasNew && props.initialSource === 'new' ? song.rewrite!.title : `${song.title} (новый вокал)`);
  const [method, setMethod] = useState<RemakeMethod>('cover');
  const [strength, setStrength] = useState(80);
  const [overlay, setOverlay] = useState(false);
  const usable = props.voices.filter((v) => v.usable);
  const [voiceId, setVoiceId] = useState<string>('');
  const [shift, setShift] = useState<number | null>(null);
  const [variants, setVariants] = useState<1 | 2>(1);
  const [keepAce, setKeepAce] = useState(true);
  const [busy, setBusy] = useState(false);

  const text = source === 'new' && hasNew ? song.rewrite!.text : song.lyrics;
  const language = detectLanguage(text, source === 'new' && hasNew ? song.rewrite!.language ?? song.language : song.language);
  const langLabel = LANGUAGES.find((l) => l.code === language)?.label ?? language;
  const start = async () => {
    setBusy(true);
    try {
      await window.api.songs.remake({ songId: song.id, text, title, method, voiceId: voiceId || null, voiceShift: shift, variants, keepAce, language, coverStrength: strength / 100, overlay: method === 'cover' && overlay });
      props.onStarted();
    } catch (e) { toast('err', errText(e)); setBusy(false); }
  };

  return (
    <Modal wide title="Новые слова на эту музыку" onClose={props.onClose} footer={<>
      <span className="hint">Получится новый трек в библиотеке · {fmtTime(song.duration)}</span>
      <button className="btn ghost" onClick={props.onClose}>Отмена</button>
      <button className="btn primary" disabled={busy || !text.trim()} onClick={start}><IcMic size={16} /> Спеть</button>
    </>}>
      <div className="grid2">
        <div className="field">
          <div className="label">Название трека</div>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field" style={{ marginTop: 0 }}>
          <div className="label">Текст</div>
          <Segmented<'new' | 'orig'> value={source} onChange={(v) => { setSource(v); if (v === 'new' && hasNew) setTitle(song.rewrite!.title); }} options={[
            { value: 'new', label: hasNew ? 'Новый текст' : 'Новый (нет)' }, { value: 'orig', label: 'Текст песни' },
          ]} />
        </div>
      </div>
      <div className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>Язык пения: <b>{langLabel}</b> · голос ACE-Step: {song.gender === 'female' ? 'женский' : 'мужской'} (меняется в карточке песни)</div>
      {source === 'new' && !hasNew && <div className="plan-line" style={{ color: 'var(--warn)' }}>Новый текст ещё не написан — перепишите его на вкладке «Новый текст» или пойте текст песни.</div>}

      <div className="field">
        <div className="label">Способ</div>
        <div className="profiles" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {METHODS.map((m) => (
            <button key={m.id} className={`profile ${method === m.id ? 'on' : ''}`} onClick={() => setMethod(m.id)}>
              <b>{m.title}</b><span>{m.desc}</span>{m.badge && <span className="rec">{m.badge}</span>}
            </button>
          ))}
        </div>
      </div>
      {method === 'cover' && (
        <div className="field">
          <div className="label">Близость к оригиналу <span className="value">{strength}%</span></div>
          <Range value={strength} min={50} max={100} step={5} onChange={setStrength} />
          <div className="range-scale"><span>свободнее</span><span>как в оригинале</span></div>
          <div className="dim" style={{ fontSize: 12.5 }}>70–90% — музыка узнаваема, а новые слова поются свободно. Ближе к 100% ACE-Step может «прорастать» старым текстом.</div>
        </div>
      )}

      <div className="grid2">
        <div className="field">
          <div className="label"><IcMic size={14} /> Голос</div>
          <select className="select" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
            <option value="">Голос ACE-Step ({song.gender === 'female' ? 'женский' : 'мужской'})</option>
            {usable.map((v) => <option key={v.id} value={v.id}>{v.name}{v.checkpoint ? ' · обучен' : ' · без обучения'}</option>)}
          </select>
        </div>
        <div className="field" style={{ marginTop: 0 }}>
          <div className="label">Вариантов</div>
          <Segmented<1 | 2> value={variants} onChange={setVariants} options={[{ value: 1, label: '1' }, { value: 2, label: '2' }]} />
        </div>
      </div>
      {voiceId && (
        <div className="field">
          <div className="label">Тон голоса</div>
          <ShiftPicker compact value={shift} onChange={setShift} />
        </div>
      )}
      {method === 'cover' && (
        <div className="field">
          <ToggleRow on={overlay} onChange={setOverlay} title="Также свести новый вокал с родным минусом"
            desc="Дополнительный вариант: вокал из ремейка кладётся на оригинальную музыку. Звучит лучше, если близость к оригиналу высокая" />
        </div>
      )}
      {(method === 'lego' || voiceId) && (
        <div className="field">
          <ToggleRow on={keepAce} onChange={setKeepAce} title="Сохранить и вариант ACE-Step как есть" desc="Рядом в библиотеке будет результат ACE-Step до обработки" />
        </div>
      )}
    </Modal>
  );
}
