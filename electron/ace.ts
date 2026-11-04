/** Клиент REST API ACE-Step 1.5 и управление его процессом. */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

export class AceError extends Error {}

export interface AceQuery {
  status: 0 | 1 | 2; // 0 идёт, 1 готово, 2 ошибка
  progress: number; // 0..1 (если сервер сообщает)
  stage: string;
  progressText: string;
  files: { file: string; seed?: string }[];
  error?: string;
}

export class AceClient {
  constructor(private endpoint: () => string) {}

  private base() { return this.endpoint().replace(/\/+$/, ''); }

  async call(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 30_000): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.base() + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new AceError(`ACE-Step недоступен (${this.base()}): ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* не JSON */ }
    if (!res.ok) throw new AceError(`ACE-Step ${path}: HTTP ${res.status} ${json?.error ?? json?.detail ?? text.slice(0, 300)}`);
    if (json && typeof json === 'object' && 'code' in json && json.code !== 200 && json.error) throw new AceError(`ACE-Step ${path}: ${json.error}`);
    return json && typeof json === 'object' && 'data' in json ? json.data : json;
  }

  /** multipart/form-data: поля запроса строками + аудио в поле src_audio. */
  async upload(path: string, req: Record<string, unknown>, file: string, timeoutMs = 300_000): Promise<any> {
    const form = new FormData();
    for (const [k, v] of Object.entries(req)) {
      if (k === 'src_audio_path' || v === undefined || v === null) continue;
      form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    form.append('src_audio', new Blob([readFileSync(file)]), basename(file));
    let res: Response;
    try {
      res = await fetch(this.base() + path, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new AceError(`ACE-Step недоступен (${this.base()}): ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* не JSON */ }
    if (!res.ok) throw new AceError(`ACE-Step ${path}: HTTP ${res.status} ${json?.error ?? json?.detail ?? text.slice(0, 300)}`);
    if (json && typeof json === 'object' && 'code' in json && json.code !== 200 && json.error) throw new AceError(`ACE-Step ${path}: ${json.error}`);
    return json && typeof json === 'object' && 'data' in json ? json.data : json;
  }

  async health(): Promise<any> { return this.call('GET', '/health', undefined, 4000); }

  async isOnline(): Promise<boolean> {
    try { await this.health(); return true; } catch { return false; }
  }

  async init(model: string, lmModel: string): Promise<void> {
    await this.call('POST', '/v1/init', { model, init_llm: true, lm_model_path: lmModel }, 900_000);
  }

  async submit(req: Record<string, unknown>): Promise<string> {
    const src = typeof req.src_audio_path === 'string' ? req.src_audio_path : '';
    // ACE-Step не принимает абсолютные пути (кроме временной папки) — локальный файл отправляем загрузкой
    const data = src && isAbsolute(src) && existsSync(src)
      ? await this.upload('/release_task', req, src)
      : await this.call('POST', '/release_task', req, 60_000);
    const id = data?.task_id ?? data?.job_id ?? data?.id;
    if (!id) throw new AceError(`ACE-Step не вернул task_id: ${JSON.stringify(data).slice(0, 300)}`);
    return String(id);
  }

  async query(taskId: string): Promise<AceQuery> {
    const data = await this.call('POST', '/query_result', { task_id_list: [taskId] }, 20_000);
    const item = Array.isArray(data) ? data[0] ?? {} : {};
    const status = (Number(item.status) || 0) as 0 | 1 | 2;
    let list: any[] = [];
    try { list = typeof item.result === 'string' ? JSON.parse(item.result || '[]') : item.result ?? []; } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const first = list[0] ?? {};
    const q: AceQuery = {
      status: status === 1 || status === 2 ? status : (status >= 2 ? 2 : 0),
      progress: Number(first.progress) || 0,
      stage: String(first.stage ?? ''),
      progressText: String(item.progress_text ?? ''),
      files: status === 1 ? list.filter((x) => x?.file).map((x) => ({ file: String(x.file), seed: x.seed_value ? String(x.seed_value) : undefined })) : [],
    };
    if (q.status === 2) q.error = String(first.error ?? item.error ?? (typeof item.result === 'string' ? item.result.slice(0, 400) : 'Ошибка генерации'));
    return q;
  }

  /** Сырой ответ по задаче (для анализа аудио: bpm, тональность, описание стиля). */
  async queryRaw(taskId: string): Promise<{ status: 0 | 1 | 2; data: any }> {
    const data = await this.call('POST', '/query_result', { task_id_list: [taskId] }, 20_000);
    const item = Array.isArray(data) ? data[0] ?? {} : {};
    const status = Number(item.status) || 0;
    let result: any = item.result;
    try { if (typeof result === 'string') result = JSON.parse(result || 'null'); } catch { /* текст */ }
    return { status: status === 1 ? 1 : status >= 2 ? 2 : 0, data: { ...item, result } };
  }

  async download(fileRef: string, dest: string): Promise<void> {
    const path = fileRef.startsWith('/') ? fileRef : `/v1/audio?path=${encodeURIComponent(fileRef)}`;
    const res = await fetch(this.base() + path, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new AceError(`Не удалось скачать аудио: HTTP ${res.status}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
}

/** Запуск acestep-api.exe так же, как это делал VEGA_Music. */
export class AceProcess {
  child: ChildProcess | null = null;
  get owned() { return !!this.child && this.child.exitCode === null; }

  start(runtimePath: string, endpoint: string, lmModel: string, logFile: string): void {
    if (this.owned) return;
    const exe = process.platform === 'win32'
      ? join(runtimePath, '.venv', 'Scripts', 'acestep-api.exe')
      : join(runtimePath, '.venv', 'bin', 'acestep-api');
    if (!existsSync(exe)) throw new AceError(`Не найден ${exe}. Проверьте путь к ACE-Step в настройках.`);
    const url = new URL(endpoint);
    mkdirSync(dirname(logFile), { recursive: true });
    const log = createWriteStream(logFile, { flags: 'a' });
    log.write(`\n===== ${new Date().toISOString()} start =====\n`);
    this.child = spawn(exe, ['--host', url.hostname, '--port', url.port || '8001', '--lm-model-path', lmModel], {
      cwd: runtimePath,
      env: { ...process.env, ACESTEP_INIT_LLM: 'true', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.pipe(log, { end: false });
    this.child.stderr?.pipe(log, { end: false });
    this.child.on('exit', (code) => { log.write(`\n===== exit ${code} =====\n`); });
  }

  stop(): void {
    const c = this.child;
    if (!c || c.exitCode !== null || !c.pid) return;
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], () => {});
    else c.kill('SIGTERM');
    this.child = null;
  }
}
