import { useEffect, useRef } from 'react';

/**
 * Живая анимация «что-то происходит»: светящаяся пульсирующая сфера,
 * переливающиеся звуковые волны, «эквалайзер» и поднимающиеся искры.
 * Энергия растёт вместе с прогрессом; при завершении — вспышка и спокойное свечение.
 */
export function Visualizer({ progress, mode }: { progress: number; mode: 'run' | 'done' | 'error' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const state = useRef({ progress, mode, flash: 0 });

  useEffect(() => {
    if (state.current.mode !== 'done' && mode === 'done') state.current.flash = 1;
    state.current.progress = progress;
    state.current.mode = mode;
  }, [progress, mode]);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let w = 0, h = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = r.width; h = r.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const sparks = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), s: 0.4 + Math.random() * 1.6, v: 0.04 + Math.random() * 0.12, p: Math.random() * 6 }));
    const BARS = 64;
    const bars = new Float32Array(BARS);
    let energy = 0.4;
    const t0 = performance.now();

    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      const st = state.current;
      const target = st.mode === 'done' ? 0.25 : st.mode === 'error' ? 0.08 : 0.55 + st.progress * 0.45;
      energy += (target - energy) * 0.03;
      st.flash *= 0.965;
      const cx = w / 2, cy = h * 0.47;
      ctx.clearRect(0, 0, w, h);

      // ── свечение-сфера: три цветных «облака», вращающихся вокруг центра
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const R = Math.min(w, h) * (0.34 + 0.04 * Math.sin(t * 2.1) * energy + st.flash * 0.25);
      const blobs = st.mode === 'error'
        ? [[251, 113, 133], [190, 60, 90], [120, 40, 70]]
        : [[139, 92, 246], [236, 72, 153], [249, 115, 22]];
      blobs.forEach(([r, g, b], i) => {
        const a = t * (0.5 + i * 0.17) + i * 2.1;
        const x = cx + Math.cos(a) * R * 0.32;
        const y = cy + Math.sin(a * 1.3) * R * 0.22;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, R);
        grd.addColorStop(0, `rgba(${r},${g},${b},${0.34 * energy + 0.12 + st.flash * 0.4})`);
        grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
      });
      ctx.restore();

      // ── кольцо, пульсирующее в такт
      const ringR = Math.min(w, h) * 0.24;
      ctx.save();
      ctx.lineWidth = 2;
      const rg = ctx.createLinearGradient(cx - ringR, cy, cx + ringR, cy);
      rg.addColorStop(0, 'rgba(167,139,250,.9)'); rg.addColorStop(0.5, 'rgba(244,114,182,.9)'); rg.addColorStop(1, 'rgba(251,146,60,.9)');
      ctx.strokeStyle = rg;
      ctx.shadowColor = 'rgba(236,72,153,.8)'; ctx.shadowBlur = 18;
      ctx.beginPath();
      for (let i = 0; i <= 180; i++) {
        const a = (i / 180) * Math.PI * 2;
        const wob = Math.sin(a * 6 + t * 3) * 0.5 + Math.sin(a * 11 - t * 4.3) * 0.35 + Math.sin(a * 3 + t * 1.7) * 0.4;
        const rr = ringR * (1 + 0.06 * wob * energy + 0.02 * Math.sin(t * 6));
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.stroke();
      // второе, тонкое кольцо, вращающееся по прогрессу
      ctx.shadowBlur = 0; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.beginPath();
      const start = -Math.PI / 2;
      ctx.arc(cx, cy, ringR * 1.16, start, start + Math.PI * 2 * Math.max(0.001, st.progress));
      ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.beginPath(); ctx.arc(cx, cy, ringR * 1.16, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();

      // ── звуковые волны через всю ширину
      const waves = 4;
      for (let k = 0; k < waves; k++) {
        const grd = ctx.createLinearGradient(0, 0, w, 0);
        grd.addColorStop(0, 'rgba(139,92,246,0)');
        grd.addColorStop(0.2, `rgba(139,92,246,${0.55 - k * 0.1})`);
        grd.addColorStop(0.5, `rgba(236,72,153,${0.7 - k * 0.12})`);
        grd.addColorStop(0.8, `rgba(249,115,22,${0.55 - k * 0.1})`);
        grd.addColorStop(1, 'rgba(249,115,22,0)');
        ctx.strokeStyle = grd;
        ctx.lineWidth = k === 0 ? 2.4 : 1.4;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 4) {
          const nx = x / w;
          const env = Math.sin(nx * Math.PI) ** 1.5;
          const y = cy + env * h * 0.16 * energy * (
            Math.sin(nx * (9 + k * 3) + t * (2.2 + k * 0.6) + k) * 0.6 +
            Math.sin(nx * (23 - k * 2) - t * (3.1 + k * 0.4)) * 0.3 +
            Math.sin(nx * 4 + t * 1.3 + k * 1.7) * 0.4);
          x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }

      // ── эквалайзер внизу
      const bw = w / BARS;
      for (let i = 0; i < BARS; i++) {
        const n = i / BARS;
        const targetH = (Math.sin(t * (3 + (i % 7) * 0.5) + i * 0.9) * 0.5 + 0.5) ** 2 * (0.4 + 0.6 * Math.sin(n * Math.PI)) * energy;
        bars[i] += (targetH - bars[i]) * 0.18;
        const bh = 4 + bars[i] * h * 0.26;
        const x = i * bw + bw * 0.22;
        const grd = ctx.createLinearGradient(0, h, 0, h - bh);
        grd.addColorStop(0, 'rgba(139,92,246,.05)');
        grd.addColorStop(1, `hsla(${265 + n * 70}, 90%, 68%, .75)`);
        ctx.fillStyle = grd;
        roundRect(ctx, x, h - bh - 6, bw * 0.56, bh, 2);
      }

      // ── искры
      for (const s of sparks) {
        s.y -= s.v * 0.016 * (0.5 + energy);
        if (s.y < -0.05) { s.y = 1.05; s.x = Math.random(); }
        const a = (Math.sin(t * 2 + s.p) * 0.5 + 0.5) * 0.7 * energy;
        ctx.fillStyle = `rgba(255,${190 + Math.round(s.p * 10)},${230 - Math.round(s.p * 20)},${a})`;
        ctx.beginPath(); ctx.arc(s.x * w + Math.sin(t + s.p) * 8, s.y * h, s.s, 0, Math.PI * 2); ctx.fill();
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return <canvas ref={ref} />;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.fill();
}
