/** Запуск Python-обработчика голоса (voice/vega_voice.py) и разбор его JSON-событий. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../src/shared/types';

export interface WorkerEvent {
  event: 'stage' | 'progress' | 'log' | 'done' | 'error';
  name?: string;
  text?: string;
  value?: number;
  message?: string;
  result?: any;
  [k: string]: unknown;
}

export class WorkerFailure extends Error {}

export interface WorkerConfig {
  python: string; // интерпретатор
  script: string; // путь к vega_voice.py
}

export function seedvcPython(seedvcPath: string): string {
  return process.platform === 'win32' ? join(seedvcPath, '.venv', 'Scripts', 'python.exe') : join(seedvcPath, '.venv', 'bin', 'python');
}

/** Аргументы с путями к Seed-VC и MelBand для команд prepare/train/apply/check. */
export function toolArgs(s: Settings, python: string): string[] {
  const a = ['--seedvc', s.seedvcPath, '--seedvc-python', python, '--separator', s.separatorPath, '--melband-models', s.melbandModelsPath];
  if (s.transformersCachePath && existsSync(s.transformersCachePath)) a.push('--transformers-cache', s.transformersCachePath);
  return a;
}

export function runWorker(
  cfg: WorkerConfig,
  args: string[],
  onEvent: (e: WorkerEvent) => void = () => {},
  signal?: AbortSignal,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!existsSync(cfg.python)) {
      reject(new WorkerFailure(`Не найден Python окружения Seed-VC: ${cfg.python}. Проверьте папку Seed-VC в настройках.`));
      return;
    }
    const child = spawn(cfg.python, [cfg.script, ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let result: any;
    let error: string | null = null;
    const tail: string[] = [];
    const onAbort = () => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) { if (line) tail.push(line); continue; }
        try {
          const ev = JSON.parse(line) as WorkerEvent;
          if (ev.event === 'done') result = ev.result;
          else if (ev.event === 'error') error = String(ev.message ?? 'Ошибка обработчика голоса');
          else onEvent(ev);
        } catch { tail.push(line); }
      }
      if (tail.length > 30) tail.splice(0, tail.length - 30);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { tail.push(...d.split('\n').filter(Boolean)); if (tail.length > 30) tail.splice(0, tail.length - 30); });
    child.on('error', (e) => reject(new WorkerFailure(`Не удалось запустить обработчик голоса: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) { reject(new DOMException('Отменено', 'AbortError')); return; }
      if (error) { reject(new WorkerFailure(friendly(error))); return; }
      if (code !== 0 || result === undefined) {
        reject(new WorkerFailure(`Обработчик голоса завершился с кодом ${code}.\n${tail.slice(-8).join('\n')}`));
        return;
      }
      resolve(result);
    });
  });
}

function friendly(msg: string): string {
  if (/out of memory|CUDA out of memory|CUBLAS_STATUS_ALLOC/i.test(msg)) {
    return 'Не хватило видеопамяти. Включите «Останавливать ACE-Step перед обработкой голоса» в настройках, закройте другие программы, использующие видеокарту, и попробуйте снова.\n\n' + msg.slice(-600);
  }
  return msg;
}
