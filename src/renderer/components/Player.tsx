import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtTime } from '../../shared/lyrics';
import type { Track } from '../../shared/types';
import { IcPause, IcPlay, IcVolume } from '../icons';
import { Cover, Range } from './ui';

interface PlayerState {
  track: Track | null;
  variant: number;
  playing: boolean;
  loading: boolean;
}

interface PlayerApi extends PlayerState {
  play(track: Track, variant: number): void;
  toggle(): void;
  audio: HTMLAudioElement;
  peaks: Float32Array | null;
}

const Ctx = createContext<PlayerApi | null>(null);
export const usePlayer = () => useContext(Ctx)!;

const cache = new Map<string, { url: string; peaks: Float32Array | null }>();

async function computePeaks(buf: ArrayBuffer, n = 220): Promise<Float32Array | null> {
  try {
    const ac = new OfflineAudioContext(1, 1, 44100);
    const audio = await ac.decodeAudioData(buf);
    const data = audio.getChannelData(0);
    const step = Math.floor(data.length / n);
    const out = new Float32Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let j = i * step; j < (i + 1) * step; j += 16) peak = Math.max(peak, Math.abs(data[j]));
      out[i] = peak; max = Math.max(max, peak);
    }
    if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
    return out;
  } catch { return null; }
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(new Audio());
  const [st, setSt] = useState<PlayerState>({ track: null, variant: 0, playing: false, loading: false });
  const [peaks, setPeaks] = useState<Float32Array | null>(null);

  useEffect(() => {
    const a = audioRef.current;
    const on = () => setSt((s) => ({ ...s, playing: !a.paused }));
    a.addEventListener('play', on); a.addEventListener('pause', on); a.addEventListener('ended', on);
    return () => { a.removeEventListener('play', on); a.removeEventListener('pause', on); a.removeEventListener('ended', on); };
  }, []);

  const play = useCallback(async (track: Track, variant: number) => {
    const a = audioRef.current;
    const v = track.variants[variant];
    if (!v) return;
    const key = `${track.id}/${v.file}`;
    if (st.track?.id === track.id && st.variant === variant && a.src) { void a.play(); return; }
    setSt({ track, variant, playing: false, loading: true });
    let entry = cache.get(key);
    if (!entry) {
      const raw = await window.api.library.readAudio(track.id, v.file);
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array((raw as Uint8Array).buffer, (raw as Uint8Array).byteOffset, (raw as Uint8Array).byteLength);
      const type = v.file.endsWith('.wav') ? 'audio/wav' : v.file.endsWith('.flac') ? 'audio/flac' : 'audio/mpeg';
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
      entry = { url, peaks: await computePeaks(bytes.slice().buffer) };
      cache.set(key, entry);
    }
    setPeaks(entry.peaks);
    a.src = entry.url;
    setSt({ track, variant, playing: false, loading: false });
    void a.play();
  }, [st.track, st.variant]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a.src) return;
    if (a.paused) void a.play(); else a.pause();
  }, []);

  return <Ctx.Provider value={{ ...st, play, toggle, audio: audioRef.current, peaks }}>{children}</Ctx.Provider>;
}

export function PlayerBar() {
  const p = usePlayer();
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(() => Number(localStorageGet('mb.volume') ?? 0.9));
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const a = p.audio;
    const upd = () => { setTime(a.currentTime); setDur(a.duration || 0); };
    a.addEventListener('timeupdate', upd); a.addEventListener('loadedmetadata', upd);
    return () => { a.removeEventListener('timeupdate', upd); a.removeEventListener('loadedmetadata', upd); };
  }, [p.audio]);

  useEffect(() => { p.audio.volume = vol; localStorageSet('mb.volume', String(vol)); }, [vol, p.audio]);

  // рисуем волну
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = r.width * dpr; c.height = r.height * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const n = p.peaks?.length ?? 120;
    const bw = r.width / n;
    const prog = dur ? time / dur : 0;
    for (let i = 0; i < n; i++) {
      const v = p.peaks ? p.peaks[i] : 0.15 + 0.1 * Math.sin(i * 0.7);
      const h = Math.max(2, v * (r.height - 6));
      const played = i / n < prog;
      ctx.fillStyle = played ? `hsl(${265 + (i / n) * 60} 90% 68%)` : 'rgba(255,255,255,.18)';
      ctx.fillRect(i * bw + bw * 0.2, (r.height - h) / 2, Math.max(1, bw * 0.6), h);
    }
  }, [p.peaks, time, dur]);

  if (!p.track) return null;
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (dur) p.audio.currentTime = ((e.clientX - r.left) / r.width) * dur;
  };

  return (
    <div className="player">
      <div className="player-info">
        <Cover title={p.track.title} small />
        <div className="pt">
          <b>{p.track.title}</b>
          <span>Вариант {p.variant + 1}{p.loading ? ' · загрузка…' : ''}</span>
        </div>
      </div>
      <div className="player-center">
        <button className="play-btn" onClick={p.toggle} aria-label="play">{p.playing ? <IcPause size={18} /> : <IcPlay size={18} />}</button>
        <span className="time">{fmtTime(time)}</span>
        <div className="wave" onClick={seek}><canvas ref={canvasRef} /></div>
        <span className="time">{fmtTime(dur)}</span>
      </div>
      <div className="player-right">
        <IcVolume size={16} />
        <Range value={vol} min={0} max={1} step={0.01} onChange={setVol} />
      </div>
    </div>
  );
}

function localStorageGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* нет хранилища */ } }
