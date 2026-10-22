"""Тесты обработчика голоса с имитациями MelBand-RoFormer и Seed-VC (нужны только numpy и scipy)."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
import zipfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
WORKER = HERE.parent / "vega_voice.py"
sys.path.insert(0, str(HERE.parent))
import vega_voice as vv  # noqa: E402

SR = 44100


def tone(hz, seconds, sr=SR, amp=0.4):
    t = np.arange(int(seconds * sr)) / sr
    x = sum((amp / k) * np.sin(2 * np.pi * hz * k * t) for k in range(1, 5))
    env = np.minimum(1, np.minimum(t / 0.05, (seconds - t) / 0.05))
    return (x * env).astype(np.float32)


def phrases(hz=196.0, count=8):
    parts = []
    rng = np.random.default_rng(1)
    for i in range(count):
        parts.append(tone(hz * (1 + 0.03 * (i % 3)), 3.5 + (i % 3)))
        parts.append(np.zeros(int(0.7 * SR), dtype=np.float32) + rng.normal(0, 1e-4, int(0.7 * SR)).astype(np.float32))
    return np.concatenate(parts)


FAKE_SEPARATOR = textwrap.dedent('''
    import argparse, os, sys
    import numpy as np
    sys.path.insert(0, {worker_dir!r})
    import vega_voice as vv
    p = argparse.ArgumentParser(); p.add_argument("--input_folder"); p.add_argument("--store_dir")
    a, _ = p.parse_known_args()
    for f in os.listdir(a.input_folder):
        data, sr = vv.read_audio(os.path.join(a.input_folder, f))
        stem = os.path.splitext(f)[0]
        vv.write_audio(os.path.join(a.store_dir, stem + "_vocals.wav"), data * 0.9, sr)
        vv.write_audio(os.path.join(a.store_dir, stem + "_instrumental.wav"), data * 0.1, sr)
''')

FAKE_INFERENCE = textwrap.dedent('''
    import argparse, os, shutil
    p = argparse.ArgumentParser()
    for k in ["--source","--target","--output","--diffusion-steps","--length-adjust","--inference-cfg-rate",
              "--f0-condition","--auto-f0-adjust","--semi-tone-shift","--fp16","--checkpoint","--config"]:
        p.add_argument(k)
    a = p.parse_args()
    os.makedirs(a.output, exist_ok=True)
    with open(os.path.join(a.output, "args.txt"), "w") as f: f.write(repr(vars(a)))
    shutil.copy(a.source, os.path.join(a.output, "vc_out.wav"))
''')

FAKE_TRAIN = textwrap.dedent('''
    import argparse, os, re
    p = argparse.ArgumentParser()
    for k in ["--config","--pretrained-ckpt","--dataset-dir","--run-name","--batch-size","--max-steps",
              "--max-epochs","--save-every","--num-workers","--gpu"]:
        p.add_argument(k)
    a = p.parse_args()
    log_dir = re.search(r'^log_dir: "(.*)"$', open(a.config, encoding="utf-8").read(), re.M).group(1)
    run = os.path.join(log_dir, a.run_name); os.makedirs(run, exist_ok=True)
    n = int(a.max_steps)
    for s in range(0, n, 10):
        print(f"epoch 0, step {s}, loss: {1.0 / (s + 1):.4f}", flush=True)
    open(os.path.join(run, "DiT_epoch_00000_step_00010.pth"), "wb").write(b"x" * 10)
    open(os.path.join(run, "ft_model.pth"), "wb").write(b"model" * 100)
    print("Final model saved", flush=True)
''')


def make_seedvc(root: Path) -> Path:
    seed = root / "seedvc"
    (seed / "configs" / "presets").mkdir(parents=True)
    (seed / "inference.py").write_text(FAKE_INFERENCE, encoding="utf-8")
    (seed / "train.py").write_text(FAKE_TRAIN, encoding="utf-8")
    (seed / vv.PRESET).write_text('log_dir: "./runs"\nsave_freq: 1\n', encoding="utf-8")
    return seed


def run_worker(*args):
    proc = subprocess.run([sys.executable, str(WORKER), *args], capture_output=True, text=True, encoding="utf-8")
    events = [json.loads(l) for l in proc.stdout.splitlines() if l.strip().startswith("{")]
    return proc.returncode, events, proc.stderr


class AnalysisTests(unittest.TestCase):
    def test_f0_estimate(self):
        for hz in (110.0, 196.0, 330.0, 523.0):
            f0 = vv.estimate_f0(tone(hz, 3), SR)
            self.assertIsNotNone(f0)
            self.assertAlmostEqual(f0, hz, delta=hz * 0.04, msg=f"{hz} → {f0}")

    def test_octave_shift_keeps_key(self):
        self.assertEqual(vv.octave_shift(130, 262), 12)    # мужской голос ACE → женская модель
        self.assertEqual(vv.octave_shift(262, 130), -12)
        self.assertEqual(vv.octave_shift(150, 180), 0)      # в пределах кварты-квинты — без сдвига
        self.assertEqual(vv.octave_shift(None, 200), 0)

    def test_voiced_regions(self):
        regs = vv.voiced_regions(phrases(count=5), SR)
        self.assertEqual(len(regs), 5)

    def test_note_name(self):
        self.assertEqual(vv.note_name(440.0), "A4")
        self.assertEqual(vv.note_name(196.0), "G3")


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vv-"))
        self.sep = self.tmp / "fake_sep.py"
        self.sep.write_text(FAKE_SEPARATOR.format(worker_dir=str(WORKER.parent)), encoding="utf-8")
        self.sep_cmd = json.dumps([sys.executable, str(self.sep)])
        self.seed = make_seedvc(self.tmp)
        song = phrases(count=8)
        stereo = np.stack([song, song], axis=1)
        self.song = vv.write_audio(self.tmp / "song.wav", stereo, SR)

    def test_prepare_from_song(self):
        manifest = self.tmp / "m.json"
        manifest.write_text(json.dumps({"sources": [{"path": self.song, "kind": "song"}]}), encoding="utf-8")
        out = self.tmp / "voice"
        code, ev, err = run_worker("prepare", "--manifest", str(manifest), "--out", str(out), "--separator-cmd", self.sep_cmd)
        self.assertEqual(code, 0, err + str(ev[-1:]))
        done = ev[-1]["result"]
        self.assertEqual(done["segments"], 8)
        self.assertGreater(done["seconds"], 25)
        self.assertAlmostEqual(done["f0Median"], 196 * 1.03, delta=12)
        self.assertTrue(done["warnings"])  # данных мало — есть подсказка
        ref, sr = vv.read_audio(out / "reference.wav")
        self.assertLessEqual(len(ref) / sr, 25)
        self.assertGreater(len(ref) / sr, 10)
        self.assertEqual(len(list((out / "dataset").glob("*.wav"))), 8)
        self.assertFalse((out / "work").exists())
        stages = [e["name"] for e in ev if e["event"] == "stage"]
        self.assertIn("separate", stages)
        values = [e["value"] for e in ev if e["event"] == "progress"]
        self.assertEqual(values, sorted(values))

    def test_prepare_rejects_silence(self):
        silent = vv.write_audio(self.tmp / "silent.wav", np.zeros(SR * 5, dtype=np.float32), SR)
        manifest = self.tmp / "m.json"
        manifest.write_text(json.dumps({"sources": [{"path": silent, "kind": "clean"}]}), encoding="utf-8")
        code, ev, _ = run_worker("prepare", "--manifest", str(manifest), "--out", str(self.tmp / "v2"))
        self.assertEqual(code, 2)
        self.assertEqual(ev[-1]["event"], "error")
        self.assertIn("чистого вокала", ev[-1]["message"])

    def test_train(self):
        ds = self.tmp / "voice" / "dataset"
        ds.mkdir(parents=True)
        vv.write_audio(ds / "a.wav", tone(200, 3), SR)
        pre = self.tmp / "pre.pth"; pre.write_bytes(b"p")
        code, ev, err = run_worker("train", "--seedvc", str(self.seed), "--seedvc-python", sys.executable,
                                   "--dataset", str(ds), "--out", str(self.tmp / "voice"), "--steps", "50", "--pretrained", str(pre))
        self.assertEqual(code, 0, err + str(ev[-1:]))
        prog = [e for e in ev if e["event"] == "progress" and e.get("step")]
        self.assertEqual(prog[-1]["step"], 40)
        self.assertEqual(prog[-1]["total"], 50)
        self.assertIsNotNone(prog[-1]["loss"])
        self.assertTrue((self.tmp / "voice" / "model" / "ft_model.pth").is_file())
        self.assertTrue((self.tmp / "voice" / "model" / "config.yml").is_file())
        self.assertFalse((self.tmp / "voice" / "runs").exists(), "промежуточные чекпойнты удалены")

    def test_apply(self):
        ref = vv.write_audio(self.tmp / "ref.wav", tone(196, 5), SR)
        out = self.tmp / "result" / "variant-1.mp3"
        code, ev, err = run_worker("apply", "--input", self.song, "--out", str(out), "--work", str(self.tmp / "work"),
                                   "--reference", ref, "--seedvc", str(self.seed), "--seedvc-python", sys.executable,
                                   "--separator-cmd", self.sep_cmd, "--target-f0", "196", "--format", "wav")
        self.assertEqual(code, 0, err + str(ev[-1:]))
        res = ev[-1]["result"]
        self.assertEqual(res["semitones"], 0)
        data, sr = vv.read_audio(res["output"])
        src, ssr = vv.read_audio(self.song)
        self.assertEqual(len(data), len(src))
        self.assertLessEqual(float(np.max(np.abs(data))), 0.99)
        self.assertFalse((self.tmp / "work").exists())

    def test_apply_octave_up_for_female_model(self):
        ref = vv.write_audio(self.tmp / "ref.wav", tone(392, 5), SR)
        code, ev, err = run_worker("apply", "--input", self.song, "--out", str(self.tmp / "o.wav"), "--work", str(self.tmp / "w"),
                                   "--reference", ref, "--seedvc", str(self.seed), "--seedvc-python", sys.executable,
                                   "--separator-cmd", self.sep_cmd, "--target-f0", "400", "--format", "wav", "--keep-work")
        self.assertEqual(code, 0, err)
        self.assertEqual(ev[-1]["result"]["semitones"], 12)
        args = (self.tmp / "w" / "converted" / "args.txt").read_text()
        self.assertIn("'semi_tone_shift': '12'", args)
        self.assertIn("'f0_condition': 'True'", args)
        self.assertIn("'auto_f0_adjust': 'False'", args)

    def test_export_import(self):
        vd = self.tmp / "voiceX"
        (vd / "model").mkdir(parents=True)
        (vd / "voice.json").write_text('{"name":"Тест"}', encoding="utf-8")
        (vd / "model" / "ft_model.pth").write_bytes(b"m" * 1000)
        (vd / "model" / "config.yml").write_text("a: 1")
        vv.write_audio(vd / "reference.wav", tone(200, 1), SR)
        (vd / "dataset").mkdir()
        (vd / "dataset" / "x.wav").write_bytes(b"skip")
        f = self.tmp / "Тест.vegavoice"
        code, ev, _ = run_worker("export", "--voice-dir", str(vd), "--out", str(f))
        self.assertEqual(code, 0)
        names = zipfile.ZipFile(f).namelist()
        self.assertIn("model/ft_model.pth", names)
        self.assertNotIn("dataset/x.wav", names)
        code, ev, _ = run_worker("import", "--file", str(f), "--out-dir", str(self.tmp / "imp"))
        self.assertEqual(code, 0)
        self.assertEqual((self.tmp / "imp" / "model" / "ft_model.pth").read_bytes(), b"m" * 1000)

    def test_import_rejects_foreign_zip(self):
        bad = self.tmp / "bad.vegavoice"
        with zipfile.ZipFile(bad, "w") as z:
            z.writestr("../evil.txt", "x")
        code, ev, _ = run_worker("import", "--file", str(bad), "--out-dir", str(self.tmp / "imp2"))
        self.assertEqual(code, 2)
        self.assertFalse((self.tmp / "evil.txt").exists())


if __name__ == "__main__":
    unittest.main()
