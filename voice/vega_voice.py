#!/usr/bin/env python
"""
VEGA-Music-AI · обработчик голоса.

Запускается из приложения интерпретатором окружения Seed-VC и общается построчным JSON в stdout:
  {"event": "stage" | "progress" | "log" | "done" | "error", ...}

Команды:
  prepare  — выделение вокала из песен (MelBand-RoFormer), нарезка на фразы, эталонный фрагмент, оценка тона
  train    — дообучение Seed-VC (певческая модель 44 кГц с F0) на нарезанных фразах
  apply    — перепевка трека: разделение → конверсия вокала Seed-VC → сведение с инструменталом
  export   — упаковка голоса в один файл .vegavoice
  import   — распаковка .vegavoice
  check    — проверка установленных компонентов
  analyze  — разбор песни (V3): вокал и минус, распознавание слов (Whisper), темп, тональность, высота голоса
  overlay  — новый вокал на родной минус (V3): вокал из результата ACE-Step (+ голос Seed-VC) → сведение с минусом

Зависимости самого скрипта: numpy, scipy (+ soundfile для mp3/flac). Всё это есть в окружении Seed-VC.
Для analyze дополнительно нужен faster-whisper (pip install faster-whisper) или transformers (уже есть в Seed-VC).
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
except Exception:
    pass

SR = 44100
PRETRAINED_NAME = "DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth"
PRESET = "configs/presets/config_dit_mel_seed_uvit_whisper_base_f0_44k.yml"
AUDIO_EXT = {".wav", ".flac", ".mp3", ".m4a", ".ogg", ".opus", ".aac"}


class WorkerError(RuntimeError):
    pass


# ───────────────────────── протокол ─────────────────────────

def emit(event: str, **kw) -> None:
    print(json.dumps({"event": event, **kw}, ensure_ascii=False), flush=True)


def stage(name: str, text: str) -> None:
    emit("stage", name=name, text=text)


def progress(value: float, text: str = "", **kw) -> None:
    emit("progress", value=round(float(min(1.0, max(0.0, value))), 4), text=text, **kw)


# ───────────────────────── аудио ─────────────────────────

def read_audio(path: str | Path) -> tuple[np.ndarray, int]:
    """Возвращает (samples × channels float32, sample_rate)."""
    path = str(path)
    try:
        import soundfile as sf  # type: ignore
        data, sr = sf.read(path, always_2d=True, dtype="float32")
        return data, int(sr)
    except ImportError:
        pass
    from scipy.io import wavfile
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        data = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        data = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.uint8:
        data = (data.astype(np.float32) - 128.0) / 128.0
    data = np.asarray(data, dtype=np.float32)
    if data.ndim == 1:
        data = data[:, None]
    return data, int(sr)


def write_audio(path: str | Path, data: np.ndarray, sr: int, fmt: str = "wav") -> str:
    """Пишет аудио. Если MP3/FLAC недоступны — пишет WAV и возвращает реальный путь."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.clip(np.asarray(data, dtype=np.float32), -1.0, 1.0)
    fmt = fmt.lower()
    if fmt in ("mp3", "flac"):
        try:
            import soundfile as sf  # type: ignore
            target = path.with_suffix("." + fmt)
            if fmt == "mp3":
                sf.write(str(target), data, sr, format="MP3", subtype="MPEG_LAYER_III")
            else:
                sf.write(str(target), data, sr, format="FLAC", subtype="PCM_24")
            return str(target)
        except Exception as exc:  # нет поддержки MP3 в libsndfile — откатываемся на WAV
            emit("log", text=f"{fmt.upper()} недоступен ({exc}), сохраняю WAV")
    target = path.with_suffix(".wav")
    try:
        import soundfile as sf  # type: ignore
        sf.write(str(target), data, sr, subtype="PCM_16")
    except ImportError:
        from scipy.io import wavfile
        wavfile.write(str(target), sr, (data * 32767.0).astype(np.int16))
    return str(target)


def to_mono(data: np.ndarray) -> np.ndarray:
    return data.mean(axis=1) if data.ndim == 2 else data


def resample(x: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target or len(x) == 0:
        return x.astype(np.float32)
    from scipy.signal import resample_poly
    g = math.gcd(sr, target)
    return resample_poly(x, target // g, sr // g, axis=0).astype(np.float32)


def rms_db(x: np.ndarray) -> float:
    if len(x) == 0:
        return -120.0
    return 20 * math.log10(max(float(np.sqrt(np.mean(np.square(x)))), 1e-9))


def frame_db(x: np.ndarray, frame: int, hop: int) -> np.ndarray:
    if len(x) < frame:
        return np.array([rms_db(x)])
    n = 1 + (len(x) - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(n)[:, None]
    frames = x[idx]
    return 20 * np.log10(np.maximum(np.sqrt(np.mean(frames ** 2, axis=1)), 1e-9))


def voiced_regions(x: np.ndarray, sr: int, top_db: float = 35.0, min_gap: float = 0.35) -> list[tuple[int, int]]:
    """Участки со звуком: кадры громче (пик − top_db), паузы короче min_gap склеиваются."""
    frame, hop = 2048, 512
    db = frame_db(x, frame, hop)
    if len(db) == 0:
        return []
    thr = max(float(np.max(db)) - top_db, -55.0)
    active = db > thr
    regions: list[tuple[int, int]] = []
    start = None
    for i, a in enumerate(active):
        if a and start is None:
            start = i
        elif not a and start is not None:
            regions.append((start * hop, min(len(x), i * hop + frame)))
            start = None
    if start is not None:
        regions.append((start * hop, len(x)))
    merged: list[tuple[int, int]] = []
    for s, e in regions:
        if merged and s - merged[-1][1] < min_gap * sr:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return merged


def split_long(s: int, e: int, sr: int, max_len: float = 14.0, target: float = 9.0) -> list[tuple[int, int]]:
    length = e - s
    if length <= max_len * sr:
        return [(s, e)]
    parts = max(2, round(length / (target * sr)))
    step = length // parts
    return [(s + i * step, s + (i + 1) * step if i < parts - 1 else e) for i in range(parts)]


def estimate_f0(x: np.ndarray, sr: int, fmin: float = 65.0, fmax: float = 1000.0) -> float | None:
    """Медианная высота тона (Гц) по автокорреляции на звонких кадрах. Достаточно для выбора октавы."""
    if len(x) < sr // 4:
        return None
    y = resample(x, sr, 16000)
    sr = 16000
    frame, hop = 1024, 256
    n = 1 + (len(y) - frame) // hop
    if n <= 0:
        return None
    step = max(1, n // 1500)
    lag_min, lag_max = int(sr / fmax), min(frame - 1, int(sr / fmin))
    win = np.hanning(frame)
    energy_thr = 10 ** ((float(np.max(frame_db(y, frame, hop))) - 30) / 20)
    vals = []
    for i in range(0, n, step):
        f = y[i * hop: i * hop + frame] * win
        if np.sqrt(np.mean(f ** 2)) < energy_thr:
            continue
        spec = np.fft.rfft(f, 2 * frame)
        ac = np.fft.irfft(np.abs(spec) ** 2)[:frame]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        seg = ac[lag_min:lag_max]
        if len(seg) == 0:
            continue
        lag = int(np.argmax(seg)) + lag_min
        if ac[lag] < 0.45:
            continue
        # уточнение параболой
        if 0 < lag < len(ac) - 1:
            a, b, c = ac[lag - 1], ac[lag], ac[lag + 1]
            d = (a - c) / (2 * (a - 2 * b + c)) if (a - 2 * b + c) != 0 else 0
            lag = lag + d
        vals.append(sr / lag)
    if len(vals) < 5:
        return None
    return float(np.median(vals))


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(hz: float | None) -> str:
    if not hz:
        return ""
    midi = int(round(69 + 12 * math.log2(hz / 440.0)))
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def octave_shift(source_hz: float | None, target_hz: float | None) -> int:
    """Сдвиг кратный октаве: сохраняет тональность относительно инструментала."""
    if not source_hz or not target_hz:
        return 0
    diff = 12 * math.log2(target_hz / source_hz)
    if abs(diff) < 7:
        return 0
    return int(max(-12, min(12, 12 * round(diff / 12))))


# ───────────────────────── внешние инструменты ─────────────────────────

def run_logged(cmd: list[str], cwd: str | None, env: dict | None, on_line=None, log_file: str | None = None) -> int:
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1, **kw)
    tail: list[str] = []
    log = open(log_file, "a", encoding="utf-8") if log_file else None
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if log:
                log.write(line)
            tail.append(line.rstrip())
            tail = tail[-40:]
            if on_line:
                on_line(line.rstrip())
    finally:
        if log:
            log.close()
    code = proc.wait()
    if code != 0:
        raise WorkerError(f"Команда завершилась с кодом {code}: {' '.join(Path(c).name for c in cmd[:2])}\n" + "\n".join(tail[-15:]))
    return code


def separator_command(args) -> list[str]:
    if args.separator_cmd:
        return json.loads(args.separator_cmd)
    exe = Path(args.separator) / ".venv" / "Scripts" / ("melband-roformer-infer.exe" if os.name == "nt" else "melband-roformer-infer")
    if not exe.is_file():
        exe = Path(args.separator) / ".venv" / "bin" / "melband-roformer-infer"
    if not exe.is_file():
        raise WorkerError(f"Не найден melband-roformer-infer в {args.separator}")
    return [str(exe), "--model", "melband-roformer-kim-vocals", "--models_dir", str(args.melband_models), "--device", "cuda"]


def separate(input_path: str, work: Path, args, log_file: str | None = None) -> tuple[str, str]:
    """Возвращает (vocals.wav, instrumental.wav)."""
    inp = work / "input"
    out = work / "stems"
    shutil.rmtree(inp, ignore_errors=True)
    shutil.rmtree(out, ignore_errors=True)
    inp.mkdir(parents=True)
    out.mkdir(parents=True)
    data, sr = read_audio(input_path)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    write_audio(inp / "track.wav", resample(data, sr, SR), SR)
    cmd = separator_command(args) + ["--input_folder", str(inp), "--store_dir", str(out)]
    cwd = args.separator if args.separator and Path(args.separator).is_dir() else None
    run_logged(cmd, cwd, os.environ.copy(), log_file=log_file)
    vocals = sorted(glob.glob(str(out / "**" / "*vocals*.wav"), recursive=True))
    inst = sorted(glob.glob(str(out / "**" / "*instrumental*.wav"), recursive=True))
    if not vocals:
        raise WorkerError("Разделение не создало файл вокала")
    if not inst:  # некоторые версии сохраняют только вокал — инструментал = микс − вокал
        mix, msr = read_audio(inp / "track.wav")
        voc, vsr = read_audio(vocals[0])
        n = min(len(mix), len(voc))
        write_audio(out / "track_instrumental.wav", mix[:n] - voc[:n], msr)
        inst = [str(out / "track_instrumental.wav")]
    return vocals[0], inst[0]


def seedvc_env(args) -> dict:
    env = os.environ.copy()
    ck = str(Path(args.seedvc) / "checkpoints")
    env.update({"HF_HOME": ck, "HF_HUB_CACHE": ck, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"})
    if getattr(args, "transformers_cache", ""):
        env["TRANSFORMERS_CACHE"] = args.transformers_cache
        env["HF_HUB_OFFLINE"] = "1"
        env["TRANSFORMERS_OFFLINE"] = "1"
    return env


def seedvc_python(args) -> str:
    return args.seedvc_python or sys.executable


def find_pretrained(seedvc: str) -> str:
    root = Path(seedvc) / "checkpoints" / "models--Plachta--Seed-VC"
    for p in glob.glob(str(root / "snapshots" / "*" / PRETRAINED_NAME)):
        try:
            if Path(p).resolve().is_file() and Path(p).stat().st_size > 100_000_000:
                return p
        except OSError:
            pass
    blobs = sorted((Path(b) for b in glob.glob(str(root / "blobs" / "*"))), key=lambda b: b.stat().st_size, reverse=True)
    if blobs and blobs[0].stat().st_size > 500_000_000:
        return str(blobs[0])
    raise WorkerError("Не найдена предобученная модель Seed-VC (singing 44k). Запустите Seed-VC один раз, чтобы скачать веса.")


# ───────────────────────── prepare ─────────────────────────

def cmd_prepare(args) -> dict:
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    out = Path(args.out)
    dataset = out / "dataset"
    work = out / "work"
    shutil.rmtree(dataset, ignore_errors=True)
    dataset.mkdir(parents=True, exist_ok=True)
    log_file = str(out / "prepare.log")
    sources = manifest["sources"]
    if not sources:
        raise WorkerError("Нет исходных файлов")

    candidates: list[tuple[float, np.ndarray]] = []  # (оценка, сегмент) для эталона
    all_voiced: list[np.ndarray] = []
    seg_count, seg_seconds = 0, 0.0
    per_source = []
    n = len(sources)
    for i, src in enumerate(sources):
        name = Path(src["path"]).name
        base = i / n
        if src.get("kind", "song") == "song":
            stage("separate", f"Выделяем вокал: {name}")
            progress(base, f"Выделяем вокал ({i + 1}/{n})")
            vocals_path, _ = separate(src["path"], work / f"s{i}", args, log_file)
        else:
            vocals_path = src["path"]
        stage("slice", f"Нарезаем фразы: {name}")
        progress(base + 0.7 / n, f"Нарезаем фразы ({i + 1}/{n})")
        data, sr = read_audio(vocals_path)
        mono = resample(to_mono(data), sr, SR)
        peak = float(np.max(np.abs(mono))) if len(mono) else 0.0
        if peak > 0:
            mono = mono * (0.95 / peak) if peak > 0.95 or peak < 0.3 else mono
        regions = voiced_regions(mono, SR)
        kept = 0
        kept_sec = 0.0
        for s, e in regions:
            for a, b in split_long(s, e, SR):
                seg = mono[a:b]
                dur = len(seg) / SR
                if dur < 2.0:
                    continue
                level = rms_db(seg)
                if level < -38:
                    continue
                clip = float(np.mean(np.abs(seg) >= 0.999))
                if clip > 0.002:
                    continue
                fade = int(0.01 * SR)
                seg = seg.copy()
                seg[:fade] *= np.linspace(0, 1, fade)
                seg[-fade:] *= np.linspace(1, 0, fade)
                write_audio(dataset / f"s{i:02d}_{kept:04d}.wav", seg, SR)
                kept += 1
                kept_sec += dur
                all_voiced.append(seg)
                # эталон: громкие, ровные фразы 4–14 с
                score = level + (3 if 4 <= dur <= 14 else 0)
                candidates.append((score, seg))
        seg_count += kept
        seg_seconds += kept_sec
        per_source.append({"name": name, "segments": kept, "seconds": round(kept_sec, 1)})
        progress((i + 1) / n, f"Готово {i + 1}/{n}")

    if seg_count == 0:
        raise WorkerError("В файлах не нашлось чистого вокала. Нужны записи, где голос хорошо слышен.")

    # эталонный фрагмент для Seed-VC (до ~25 с): лучшие фразы подряд с короткими паузами
    candidates.sort(key=lambda c: c[0], reverse=True)
    ref_parts, total = [], 0.0
    gap = np.zeros(int(0.15 * SR), dtype=np.float32)
    for _, seg in candidates:
        if total + len(seg) / SR > 24:
            continue
        ref_parts += [seg, gap]
        total += len(seg) / SR + 0.15
        if total >= 18:
            break
    reference = np.concatenate(ref_parts) if ref_parts else candidates[0][1]
    ref_path = write_audio(out / "reference.wav", reference, SR)

    sample = np.concatenate(all_voiced)[: SR * 120]
    f0 = estimate_f0(sample, SR)
    warnings = []
    if seg_seconds < 30:
        warnings.append("Очень мало чистого вокала (меньше 30 с). Голос будет похож лишь отдалённо — добавьте ещё песен.")
    elif seg_seconds < 180:
        warnings.append("Данных немного. Для лучшего сходства добавьте 2–4 песни (желательно 5+ минут вокала).")
    shutil.rmtree(work, ignore_errors=True)
    result = {
        "segments": seg_count,
        "seconds": round(seg_seconds, 1),
        "reference": Path(ref_path).name,
        "f0Median": round(f0, 1) if f0 else None,
        "note": note_name(f0),
        "sources": per_source,
        "warnings": warnings,
    }
    return result


# ───────────────────────── train ─────────────────────────

def derive_config(seedvc: str, run_root: Path, target: Path) -> Path:
    preset = Path(seedvc) / PRESET
    if not preset.is_file():
        raise WorkerError(f"Не найден конфиг Seed-VC: {preset}")
    text = preset.read_text(encoding="utf-8")
    text = re.sub(r'^log_dir:.*$', f'log_dir: "{run_root.as_posix()}"', text, flags=re.M)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return target


STEP_RE = re.compile(r"step\s+(\d+),\s*loss:\s*([0-9.eE+-]+)")


def cmd_train(args) -> dict:
    out = Path(args.out)
    dataset = Path(args.dataset)
    files = [f for f in dataset.glob("*") if f.suffix.lower() in AUDIO_EXT]
    if not files:
        raise WorkerError("Датасет пуст — сначала подготовьте голос")
    runs = out / "runs"
    run_name = "voice"
    config = derive_config(args.seedvc, runs, out / "model" / "config.yml")
    run_dir = runs / run_name
    resuming = bool(glob.glob(str(run_dir / "DiT_epoch_*_step_*.pth")))
    steps = int(args.steps)
    save_every = max(50, min(500, steps // 3))
    cmd = [seedvc_python(args), "train.py", "--config", str(config)]
    if not resuming:
        cmd += ["--pretrained-ckpt", args.pretrained or find_pretrained(args.seedvc)]
    cmd += ["--dataset-dir", str(dataset), "--run-name", run_name, "--batch-size", str(args.batch),
            "--max-steps", str(steps), "--max-epochs", "100000", "--save-every", str(save_every),
            "--num-workers", "0", "--gpu", "0"]
    stage("train", "Обучаем модель голоса")
    progress(0.0, "Загружаем модели Seed-VC…", step=0, total=steps)
    t0 = time.time()
    last = {"step": 0, "loss": None}

    def on_line(line: str):
        m = STEP_RE.search(line)
        if m:
            step, loss = int(m.group(1)), float(m.group(2))
            last.update(step=step, loss=loss)
            el = time.time() - t0
            eta = el / step * (steps - step) if step > 0 else None
            progress(step / steps, f"Шаг {step} из {steps}", step=step, total=steps, loss=round(loss, 4),
                     eta=round(eta) if eta else None)

    run_logged(cmd, args.seedvc, seedvc_env(args), on_line, str(out / "train.log"))
    final = run_dir / "ft_model.pth"
    if not final.is_file():
        raise WorkerError("Обучение завершилось без файла ft_model.pth — см. train.log")
    model_dir = out / "model"
    model_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(final), str(model_dir / "ft_model.pth"))
    # промежуточные чекпойнты с оптимизатором весят гигабайты — удаляем
    if not args.keep_checkpoints:
        shutil.rmtree(runs, ignore_errors=True)
    return {"checkpoint": "model/ft_model.pth", "config": "model/config.yml", "steps": steps,
            "finalLoss": last["loss"], "seconds": round(time.time() - t0)}


# ───────────────────────── apply ─────────────────────────

def convert_vocals(vocals: str, reference: str, out_dir: Path, args, semitones: int, log_file: str | None) -> str:
    out_dir.mkdir(parents=True, exist_ok=True)
    before = set(glob.glob(str(out_dir / "*.wav")))
    cmd = [seedvc_python(args), "inference.py", "--source", vocals, "--target", reference, "--output", str(out_dir),
           "--diffusion-steps", str(args.steps), "--length-adjust", "1.0", "--inference-cfg-rate", "0.7",
           "--f0-condition", "True", "--auto-f0-adjust", "False", "--semi-tone-shift", str(semitones), "--fp16", "True"]
    if args.checkpoint:
        cmd += ["--checkpoint", args.checkpoint, "--config", args.config]
    run_logged(cmd, args.seedvc, seedvc_env(args), log_file=log_file)
    created = sorted(set(glob.glob(str(out_dir / "*.wav"))) - before, key=os.path.getmtime)
    if not created:
        raise WorkerError("Seed-VC не создал файл с вокалом")
    return created[-1]


def mix(instrumental: str, original_vocals: str, converted: str, out: str, fmt: str, vocal_gain_db: float = 0.0) -> str:
    inst, isr = read_audio(instrumental)
    orig, osr = read_audio(original_vocals)
    conv, csr = read_audio(converted)
    sr = isr
    conv = resample(conv, csr, sr)
    orig = resample(orig, osr, sr)
    ch = inst.shape[1]
    if conv.shape[1] != ch:
        conv = np.repeat(to_mono(conv)[:, None], ch, axis=1)
    n = len(inst)
    if len(conv) < n:
        conv = np.concatenate([conv, np.zeros((n - len(conv), ch), dtype=np.float32)])
    conv = conv[:n]
    # громкость нового вокала — как у исходного (по звучащим участкам)
    def active_rms(x):
        m = np.abs(to_mono(x))
        sel = m[m > 0.01]
        return float(np.sqrt(np.mean(sel ** 2))) if len(sel) else 0.0
    ro, rc = active_rms(orig), active_rms(conv)
    gain = (ro / rc) if rc > 1e-6 and ro > 1e-6 else 1.0
    gain = float(np.clip(gain, 0.25, 4.0)) * 10 ** (vocal_gain_db / 20)
    out_mix = inst + conv * gain
    peak = float(np.max(np.abs(out_mix))) if out_mix.size else 0.0
    if peak > 0.98:
        out_mix *= 0.98 / peak
    return write_audio(out, out_mix, sr, fmt)


def cmd_apply(args) -> dict:
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    log_file = str(work / "apply.log")
    stage("separate", "Отделяем вокал от музыки")
    progress(0.02, "Отделяем вокал от музыки")
    vocals, inst = separate(args.input, work, args, log_file)
    progress(0.3, "Определяем тон")
    if args.semitones == "auto":
        v, vsr = read_audio(vocals)
        src_f0 = estimate_f0(to_mono(v)[: vsr * 90], vsr)
        semis = octave_shift(src_f0, float(args.target_f0) if args.target_f0 else None)
    else:
        semis = int(args.semitones)
    stage("convert", "Перепеваем вокал выбранным голосом")
    progress(0.35, "Перепеваем вокал выбранным голосом", semitones=semis)
    converted = convert_vocals(vocals, args.reference, work / "converted", args, semis, log_file)
    stage("mix", "Сводим вокал с музыкой")
    progress(0.9, "Сводим вокал с музыкой")
    result = mix(inst, vocals, converted, args.out, args.format, float(args.vocal_gain))
    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    progress(1.0, "Готово")
    return {"output": result, "semitones": semis}


# ───────────────────────── analyze (песня → текст и параметры) ─────────────────────────

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# профили Крумхансла — Кесслер
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _stft_mag(y: np.ndarray, frame: int, hop: int, max_frames: int = 20000) -> np.ndarray:
    if len(y) < frame:
        y = np.pad(y, (0, frame - len(y)))
    n = 1 + (len(y) - frame) // hop
    n = min(n, max_frames)
    win = np.hanning(frame).astype(np.float32)
    out = np.empty((n, frame // 2 + 1), dtype=np.float32)
    for i0 in range(0, n, 512):
        i1 = min(n, i0 + 512)
        idx = np.arange(frame)[None, :] + hop * np.arange(i0, i1)[:, None]
        out[i0:i1] = np.abs(np.fft.rfft(y[idx] * win, axis=1))
    return out


def estimate_bpm(x: np.ndarray, sr: int, max_sec: float = 150.0) -> float | None:
    """Темп по автокорреляции огибающей атак (спектральный поток), с приоритетом 70–170 BPM."""
    y = resample(x[: int(sr * max_sec)], sr, 11025)
    if len(y) < 11025 * 6:
        return None
    sr2, frame, hop = 11025, 1024, 256
    fps = sr2 / hop
    mag = np.log1p(100.0 * _stft_mag(y, frame, hop))
    flux = np.maximum(0.0, np.diff(mag, axis=0)).sum(axis=1)
    if flux.size < 64 or float(flux.max()) <= 0:
        return None
    k = max(1, int(fps * 0.5))
    smooth = np.convolve(flux, np.ones(k) / k, mode="same")
    onset = np.maximum(0.0, flux - smooth)
    onset -= onset.mean()
    spec = np.fft.rfft(onset, 2 * len(onset))
    ac = np.fft.irfft(np.abs(spec) ** 2)[: len(onset)]
    if ac[0] <= 0:
        return None
    ac /= ac[0]

    def at(lag: float) -> float:
        if lag >= len(ac) - 1 or lag < 1:
            return 0.0
        i = int(lag)
        f = lag - i
        return float(ac[i] * (1 - f) + ac[i + 1] * f)

    best, best_score = None, -1e9
    for bpm in np.arange(60.0, 200.0, 0.25):
        lag = 60.0 * fps / bpm
        score = at(lag) + 0.5 * at(2 * lag) + 0.25 * at(4 * lag)
        prior = math.exp(-0.5 * (math.log2(bpm / 118.0) / 0.75) ** 2)
        score *= prior
        if score > best_score:
            best, best_score = float(bpm), score
    return round(best, 1) if best else None


def estimate_key(x: np.ndarray, sr: int, max_sec: float = 150.0) -> str | None:
    """Тональность: хромаграмма по спектру + корреляция с профилями мажора/минора."""
    y = resample(x[: int(sr * max_sec)], sr, 11025)
    if len(y) < 11025 * 4:
        return None
    frame, hop = 4096, 2048
    mag = _stft_mag(y, frame, hop)
    freqs = np.fft.rfftfreq(frame, 1.0 / 11025)
    sel = (freqs > 60) & (freqs < 2100)
    midi = 69 + 12 * np.log2(freqs[sel] / 440.0)
    pc = np.mod(np.round(midi), 12).astype(int)
    energy = (mag[:, sel] ** 2).sum(axis=0)
    chroma = np.bincount(pc, weights=energy, minlength=12)
    if chroma.sum() <= 0:
        return None
    chroma = chroma / chroma.max()
    best, best_r = None, -2.0
    for tonic in range(12):
        for name, prof in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            r = float(np.corrcoef(chroma, np.roll(prof, tonic))[0, 1])
            if r > best_r:
                best, best_r = f"{KEY_NAMES[tonic]} {name}", r
    return best


def guess_language(text: str) -> str:
    if re.search(r"[іїєґІЇЄҐ]", text):
        return "uk"
    if re.search(r"[а-яА-ЯёЁ]", text):
        return "ru"
    if re.search(r"[぀-ヿ]", text):
        return "ja"
    if re.search(r"[가-힯]", text):
        return "ko"
    if re.search(r"[一-鿿]", text):
        return "zh"
    return "en"


def _torch_dll_dirs() -> None:
    """На Windows ctranslate2 (faster-whisper) находит CUDA-библиотеки из папки torch."""
    if os.name != "nt":
        return
    try:
        import torch  # type: ignore
        lib = Path(torch.__file__).parent / "lib"
        if lib.is_dir():
            os.add_dll_directory(str(lib))  # type: ignore[attr-defined]
            os.environ["PATH"] = str(lib) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


def _cuda() -> bool:
    try:
        import torch  # type: ignore
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def asr_available() -> str | None:
    try:
        import faster_whisper  # type: ignore  # noqa: F401
        return "faster-whisper"
    except Exception:
        pass
    try:
        import transformers  # type: ignore  # noqa: F401
        return "transformers"
    except Exception:
        return None


def transcribe_faster_whisper(audio16: np.ndarray, args, duration: float):
    _torch_dll_dirs()
    from faster_whisper import WhisperModel  # type: ignore
    root = args.asr_models or None
    if root:
        Path(root).mkdir(parents=True, exist_ok=True)
    device = "cuda" if _cuda() else "cpu"
    try:
        model = WhisperModel(args.asr_model, device=device, compute_type="float16" if device == "cuda" else "int8", download_root=root)
    except Exception as e:  # нет cuDNN/cuBLAS — работаем на процессоре
        if device != "cuda":
            raise
        emit("log", text=f"Whisper на видеокарте не запустился ({e}), распознаю на процессоре — будет медленнее")
        device = "cpu"
        model = WhisperModel(args.asr_model, device="cpu", compute_type="int8", download_root=root)
    lang = None if args.language in ("", "auto") else args.language

    def run(vad: bool, audio=None, language=None, report=True):
        segments, info = model.transcribe(
            audio16 if audio is None else audio, language=language or lang, task="transcribe", beam_size=5, word_timestamps=True,
            vad_filter=vad, vad_parameters={"min_silence_duration_ms": 700, "speech_pad_ms": 300, "threshold": 0.3} if vad else None,
            condition_on_previous_text=False, no_speech_threshold=0.6, compression_ratio_threshold=2.4,
            temperature=[0.0, 0.2, 0.4],
        )
        words: list[dict] = []
        for seg in segments:
            for w in seg.words or []:
                t = (w.word or "").strip()
                if t:
                    words.append({"w": t, "s": round(float(w.start), 2), "e": round(float(w.end), 2)})
            if report:
                progress(0.45 + 0.4 * min(1.0, float(seg.end) / max(1.0, duration)), f"Распознаём слова · {fmt_time(seg.end)} из {fmt_time(duration)}")
        return words, info.language

    try:
        words, detected = run(True)
        if not words:
            words, detected = run(False)
    except RuntimeError as e:
        if device == "cuda" and re.search(r"cudnn|cublas|cuda", str(e), re.I):
            emit("log", text=f"Ошибка CUDA в Whisper ({e}), повторяю на процессоре")
            model = WhisperModel(args.asr_model, device="cpu", compute_type="int8", download_root=root)
            words, detected = run(True)
        else:
            raise
    final_lang = lang or detected or ""
    return words, final_lang, lambda chunk: run(False, chunk, final_lang or None, False)[0]


def transcribe_transformers(audio16: np.ndarray, args, duration: float):
    import torch  # type: ignore
    from transformers import pipeline  # type: ignore
    name = args.asr_model if "/" in args.asr_model else f"openai/whisper-{args.asr_model}"
    cuda = _cuda()
    kw = {"cache_dir": args.asr_models} if args.asr_models else {}
    pipe = pipeline("automatic-speech-recognition", model=name, torch_dtype=torch.float16 if cuda else torch.float32,
                    device=0 if cuda else -1, model_kwargs=kw)
    lang = None if args.language in ("", "auto") else args.language
    gen = {"task": "transcribe"}
    if lang:
        gen["language"] = lang

    def run_part(part: np.ndarray, off: float) -> list[dict]:
        out = pipe({"raw": part, "sampling_rate": 16000}, return_timestamps="word", generate_kwargs=gen)
        res = []
        for c in out.get("chunks", []):
            ts = c.get("timestamp") or (None, None)
            t = (c.get("text") or "").strip()
            if not t or ts[0] is None:
                continue
            s = float(ts[0]) + off
            e = float(ts[1]) + off if ts[1] is not None else s + 0.3
            res.append({"w": t, "s": round(s, 2), "e": round(e, 2)})
        return res

    words: list[dict] = []
    chunk = 30 * 16000
    for i0 in range(0, len(audio16), chunk):
        part = audio16[i0:i0 + chunk]
        if rms_db(part) < -50:
            continue
        words += run_part(part, i0 / 16000)
        progress(0.45 + 0.4 * min(1.0, (i0 + chunk) / max(1, len(audio16))), f"Распознаём слова · {fmt_time((i0 + chunk) / 16000)} из {fmt_time(duration)}")
    text = " ".join(w["w"] for w in words)
    return words, (lang or guess_language(text)), lambda part: run_part(part, 0.0)


HALLUCINATION_RE = re.compile(r"^(thank you|thanks|bye|bye-bye|you|music|пока|спасибо|музыка)[.!\s]*$|субтитр|продолжение следует|amara\.org|subscribe", re.I)


def fill_gaps(audio16: np.ndarray, words: list[dict], run_chunk, sr: int = 16000, max_regions: int = 40) -> list[dict]:
    """
    Whisper пропускает повторы и затухание в конце. Участки, где голос звучит, а слов почти нет,
    распознаются отдельно, найденные слова добавляются.
    """
    regions = voiced_regions(audio16, sr, top_db=32, min_gap=0.6)
    gaps = []
    for s0, e0 in regions:
        a, b = s0 / sr, e0 / sr
        if b - a < 1.2:
            continue
        covered = sum(max(0.0, min(b, w["e"]) - max(a, w["s"])) for w in words if w["e"] > a and w["s"] < b)
        if covered / (b - a) < 0.25:
            gaps.append((max(0.0, a - 0.3), min(len(audio16) / sr, b + 0.3)))
    gaps = gaps[:max_regions]
    added: list[dict] = []
    for i, (a, b) in enumerate(gaps):
        progress(0.86 + 0.12 * (i / max(1, len(gaps))), f"Дослушиваем пропуски · {i + 1} из {len(gaps)}")
        try:
            found = run_chunk(audio16[int(a * sr):int(b * sr)])
        except Exception as e:  # noqa: BLE001
            emit("log", text=f"Не удалось дослушать {fmt_time(a)}–{fmt_time(b)}: {e}")
            continue
        text = " ".join(w["w"] for w in found).strip().lower()
        if not text or HALLUCINATION_RE.search(text):
            continue
        for w in found:
            ws, we = w["s"] + a, w["e"] + a
            if any(x["s"] < we and x["e"] > ws for x in words):
                continue
            added.append({"w": w["w"], "s": round(ws, 2), "e": round(we, 2)})
    if added:
        emit("log", text=f"Дослушано слов: {len(added)}")
    return sorted(words + added, key=lambda w: w["s"])


def fmt_time(sec: float) -> str:
    sec = max(0, int(round(sec)))
    return f"{sec // 60}:{sec % 60:02d}"


def transcribe(vocals: str, args, duration: float) -> tuple[list[dict], str, str]:
    fake = args.asr_fake or os.environ.get("VEGA_ASR_FAKE", "")  # для тестов
    if fake:
        data = json.loads(Path(fake).read_text(encoding="utf-8"))
        progress(0.9, "Распознаём слова")
        words = data["words"] if isinstance(data, dict) else data
        lang = (data.get("language") if isinstance(data, dict) else None) or guess_language(" ".join(w["w"] for w in words))
        return words, lang, "fake"
    v, vsr = read_audio(vocals)
    audio16 = resample(to_mono(v), vsr, 16000).astype(np.float32)
    backend = args.asr_backend
    if backend in ("auto", "faster-whisper"):
        try:
            import faster_whisper  # type: ignore  # noqa: F401
            words, lang, chunk_fn = transcribe_faster_whisper(audio16, args, duration)
            return fill_gaps(audio16, words, chunk_fn), lang, "faster-whisper"
        except ImportError:
            if backend == "faster-whisper":
                raise WorkerError("Не установлен faster-whisper. Установите его в окружение Seed-VC: .venv\\Scripts\\pip install faster-whisper")
    try:
        import transformers  # type: ignore  # noqa: F401
    except ImportError:
        raise WorkerError("Нет модуля распознавания речи. Установите faster-whisper в окружение Seed-VC: .venv\\Scripts\\pip install faster-whisper")
    words, lang, chunk_fn = transcribe_transformers(audio16, args, duration)
    return fill_gaps(audio16, words, chunk_fn), lang, "transformers"


def cmd_analyze(args) -> dict:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    work = out / ".work"
    log_file = str(out / "analyze.log")
    warnings: list[str] = []
    data, sr = read_audio(args.input)
    duration = round(len(data) / sr, 2)
    if duration < 10:
        raise WorkerError("Файл слишком короткий — нужна песня хотя бы 10 секунд")

    stage("separate", "Отделяем голос от музыки")
    progress(0.02, "Отделяем голос от музыки")
    vocals_tmp, inst_tmp = separate(args.input, work, args, log_file)
    shutil.copyfile(vocals_tmp, out / "vocals.wav")
    shutil.copyfile(inst_tmp, out / "instrumental.wav")
    shutil.rmtree(work, ignore_errors=True)

    stage("music", "Определяем темп и тональность")
    progress(0.35, "Определяем темп и тональность")
    inst, isr = read_audio(out / "instrumental.wav")
    bpm = estimate_bpm(to_mono(inst), isr)
    key = estimate_key(to_mono(inst), isr)
    voc, vsr = read_audio(out / "vocals.wav")
    vm = to_mono(voc)
    f0 = estimate_f0(vm, vsr)
    vocal_sec = sum(e - s for s, e in voiced_regions(vm, vsr)) / vsr
    if vocal_sec < 8:
        warnings.append("В песне почти не слышно голоса — текст может не распознаться")

    stage("transcribe", "Распознаём слова")
    progress(0.42, "Загружаем модель распознавания…")
    words, lang, backend = transcribe(str(out / "vocals.wav"), args, duration)
    if not words:
        warnings.append("Слова не распознаны — впишите текст вручную")
    (out / "words.json").write_text(json.dumps({"language": lang, "words": words}, ensure_ascii=False), encoding="utf-8")
    progress(1.0, "Готово")
    return {
        "duration": duration, "bpm": bpm, "key": key, "f0Median": f0, "note": note_name(f0),
        "language": lang, "words": words, "asr": backend,
        "vocals": "vocals.wav", "instrumental": "instrumental.wav", "vocalSeconds": round(vocal_sec, 1), "warnings": warnings,
    }


# ───────────────────────── overlay (новый вокал на родной минус) ─────────────────────────

def cmd_overlay(args) -> dict:
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    log_file = str(work / "overlay.log")
    stage("separate", "Выделяем новый вокал")
    progress(0.03, "Выделяем новый вокал")
    new_vocals, _ = separate(args.input, work, args, log_file)
    semis = 0
    voice = new_vocals
    if args.reference:
        if args.semitones == "auto":
            v, vsr = read_audio(new_vocals)
            semis = octave_shift(estimate_f0(to_mono(v)[: vsr * 90], vsr), float(args.target_f0) if args.target_f0 else None)
        else:
            semis = int(args.semitones)
        stage("convert", "Перепеваем выбранным голосом")
        progress(0.35, "Перепеваем выбранным голосом", semitones=semis)
        voice = convert_vocals(new_vocals, args.reference, work / "converted", args, semis, log_file)
    stage("mix", "Сводим новый вокал с исходной музыкой")
    progress(0.9, "Сводим новый вокал с исходной музыкой")
    result = mix(args.instrumental, args.orig_vocals, voice, args.out, args.format, float(args.vocal_gain))
    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    progress(1.0, "Готово")
    return {"output": result, "semitones": semis}


# ───────────────────────── export / import / check ─────────────────────────

EXPORT_FILES = ["voice.json", "reference.wav", "model/ft_model.pth", "model/config.yml"]


def cmd_export(args) -> dict:
    src = Path(args.voice_dir)
    if not (src / "voice.json").is_file():
        raise WorkerError("Не найден voice.json")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".part")
    stage("export", "Упаковываем голос")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED) as z:
        z.writestr("vegavoice.json", json.dumps({"format": "vegavoice", "version": 1}))
        for rel in EXPORT_FILES:
            p = src / rel
            if p.is_file():
                z.write(p, rel)
    tmp.replace(out)
    return {"file": str(out), "bytes": out.stat().st_size}


def cmd_import(args) -> dict:
    dst = Path(args.out_dir)
    dst.mkdir(parents=True, exist_ok=True)
    stage("import", "Распаковываем голос")
    with zipfile.ZipFile(args.file) as z:
        names = z.namelist()
        if "vegavoice.json" not in names or "voice.json" not in names:
            raise WorkerError("Это не файл голоса VEGA-Music-AI")
        for name in names:
            if name not in EXPORT_FILES and name != "vegavoice.json":
                continue
            target = (dst / name).resolve()
            if not str(target).startswith(str(dst.resolve())):
                raise WorkerError("Повреждённый архив")
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(name) as fsrc, open(target, "wb") as fdst:
                shutil.copyfileobj(fsrc, fdst, 1024 * 1024)
    return {"dir": str(dst)}


def cmd_check(args) -> dict:
    problems = []
    seed = Path(args.seedvc or "")
    if not (seed / "inference.py").is_file():
        problems.append(f"Seed-VC не найден: {seed}")
    else:
        try:
            find_pretrained(str(seed))
        except WorkerError as e:
            problems.append(str(e))
    try:
        separator_command(args)
    except WorkerError as e:
        problems.append(str(e))
    if not args.separator_cmd and args.melband_models and not Path(args.melband_models).is_dir():
        problems.append(f"Папка моделей MelBand-RoFormer не найдена: {args.melband_models}")
    try:
        import torch  # type: ignore
        cuda = bool(torch.cuda.is_available())
        if not cuda:
            problems.append("PyTorch в окружении Seed-VC не видит видеокарту (CUDA)")
    except Exception:
        cuda = None
        problems.append("В окружении Seed-VC не установлен PyTorch")
    return {"ok": not problems, "problems": problems, "cuda": cuda, "python": sys.version.split()[0], "asr": asr_available()}


# ───────────────────────── main ─────────────────────────

def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="vega_voice")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--seedvc", default="")
        sp.add_argument("--seedvc-python", default="")
        sp.add_argument("--separator", default="")
        sp.add_argument("--separator-cmd", default="")
        sp.add_argument("--melband-models", default="")
        sp.add_argument("--transformers-cache", default="")

    sp = sub.add_parser("prepare"); common(sp)
    sp.add_argument("--manifest", required=True); sp.add_argument("--out", required=True)

    sp = sub.add_parser("train"); common(sp)
    sp.add_argument("--dataset", required=True); sp.add_argument("--out", required=True)
    sp.add_argument("--steps", type=int, default=800); sp.add_argument("--batch", type=int, default=2)
    sp.add_argument("--pretrained", default=""); sp.add_argument("--keep-checkpoints", action="store_true")

    sp = sub.add_parser("apply"); common(sp)
    sp.add_argument("--input", required=True); sp.add_argument("--out", required=True)
    sp.add_argument("--work", required=True); sp.add_argument("--reference", required=True)
    sp.add_argument("--checkpoint", default=""); sp.add_argument("--config", default="")
    sp.add_argument("--steps", type=int, default=25); sp.add_argument("--semitones", default="auto")
    sp.add_argument("--target-f0", default=""); sp.add_argument("--format", default="mp3")
    sp.add_argument("--vocal-gain", default="0"); sp.add_argument("--keep-work", action="store_true")

    sp = sub.add_parser("export"); sp.add_argument("--voice-dir", required=True); sp.add_argument("--out", required=True)
    sp = sub.add_parser("import"); sp.add_argument("--file", required=True); sp.add_argument("--out-dir", required=True)
    sp = sub.add_parser("check"); common(sp)

    sp = sub.add_parser("analyze"); common(sp)
    sp.add_argument("--input", required=True); sp.add_argument("--out", required=True)
    sp.add_argument("--language", default="auto"); sp.add_argument("--asr-backend", default="auto")
    sp.add_argument("--asr-model", default="large-v3"); sp.add_argument("--asr-models", default="")
    sp.add_argument("--asr-fake", default="")

    sp = sub.add_parser("overlay"); common(sp)
    sp.add_argument("--input", required=True); sp.add_argument("--instrumental", required=True)
    sp.add_argument("--orig-vocals", required=True); sp.add_argument("--out", required=True); sp.add_argument("--work", required=True)
    sp.add_argument("--reference", default=""); sp.add_argument("--checkpoint", default=""); sp.add_argument("--config", default="")
    sp.add_argument("--steps", type=int, default=25); sp.add_argument("--semitones", default="auto")
    sp.add_argument("--target-f0", default=""); sp.add_argument("--format", default="mp3")
    sp.add_argument("--vocal-gain", default="0"); sp.add_argument("--keep-work", action="store_true")

    args = p.parse_args(argv)
    handlers = {"prepare": cmd_prepare, "train": cmd_train, "apply": cmd_apply,
                "export": cmd_export, "import": cmd_import, "check": cmd_check,
                "analyze": cmd_analyze, "overlay": cmd_overlay}
    try:
        result = handlers[args.cmd](args)
        emit("done", result=result)
        return 0
    except WorkerError as e:
        emit("error", message=str(e))
        return 2
    except Exception as e:  # noqa: BLE001
        import traceback
        emit("error", message=f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-2000:])
        return 1


if __name__ == "__main__":
    sys.exit(main())
