import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { IcAlert, IcCheck, IcX } from '../icons';

export function Switch({ on }: { on: boolean }) {
  return <span className={`switch ${on ? 'on' : ''}`} />;
}

export function ToggleRow(props: { on: boolean; onChange: (v: boolean) => void; title: ReactNode; desc?: ReactNode; className?: string }) {
  return (
    <div className={`toggle-row ${props.className ?? ''} ${props.on ? 'on' : ''}`} role="switch" aria-checked={props.on} tabIndex={0}
      onClick={() => props.onChange(!props.on)}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); props.onChange(!props.on); } }}>
      <div className="t-text">
        <div className="t-title">{props.title}</div>
        {props.desc && <div className="t-desc">{props.desc}</div>}
      </div>
      <Switch on={props.on} />
    </div>
  );
}

export function Segmented<T extends string | number>(props: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <button key={String(o.value)} className={o.value === props.value ? 'on' : ''} onClick={() => props.onChange(o.value)} type="button">{o.label}</button>
      ))}
    </div>
  );
}

export function Range(props: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <input className="range" type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value}
      style={{ ['--p' as string]: `${pct}%` }} onChange={(e) => props.onChange(Number(e.target.value))} />
  );
}

export function ChipPicker(props: {
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  allowCustom?: boolean;
  collapsedCount?: number;
  placeholder?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const custom = props.value.filter((v) => !props.options.includes(v));
  const visible = expanded || !props.collapsedCount ? props.options : props.options.slice(0, props.collapsedCount);
  const shown = [...new Set([...visible, ...props.value.filter((v) => props.options.includes(v))])];
  const toggle = (o: string) => props.onChange(props.value.includes(o) ? props.value.filter((x) => x !== o) : [...props.value, o]);
  const add = () => {
    const v = draft.trim();
    if (v && !props.value.some((x) => x.toLowerCase() === v.toLowerCase())) props.onChange([...props.value, v]);
    setDraft('');
  };
  return (
    <div className="chips">
      {shown.map((o) => (
        <button key={o} type="button" className={`chip ${props.value.includes(o) ? 'on' : ''}`} onClick={() => toggle(o)}>{o}</button>
      ))}
      {custom.map((o) => (
        <span key={o} className="chip on custom">{o}<span className="x" role="button" onClick={() => toggle(o)}><IcX size={12} /></span></span>
      ))}
      {props.collapsedCount && props.options.length > props.collapsedCount && (
        <button type="button" className="chips-more" onClick={() => setExpanded(!expanded)}>{expanded ? 'Свернуть' : `Ещё ${props.options.length - props.collapsedCount}`}</button>
      )}
      {props.allowCustom && (
        <input className="chip-input" placeholder={props.placeholder ?? '+ свой вариант'} value={draft}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} onBlur={add} />
      )}
    </div>
  );
}

/** Детерминированная «обложка» из названия. */
export function Cover({ title, small }: { title: string; small?: boolean }) {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 50 + (h >> 8) % 80) % 360;
  const letter = (title.trim()[0] ?? '♪').toUpperCase();
  return (
    <div className={`cover ${small ? 'sm' : ''}`} style={{
      background: `radial-gradient(circle at 25% 20%, hsl(${a} 85% 62%), transparent 60%), radial-gradient(circle at 80% 85%, hsl(${b} 85% 55%), transparent 55%), linear-gradient(135deg, hsl(${a} 50% 22%), hsl(${b} 55% 18%))`,
    }}>{letter}</div>
  );
}

// ───── Тосты ─────
interface Toast { id: number; kind: 'ok' | 'err' | 'info'; text: string }
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.kind === 'err' ? <IcAlert size={16} /> : <IcCheck size={16} />}{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
