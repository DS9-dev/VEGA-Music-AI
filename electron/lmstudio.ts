/** Клиент LM Studio: список моделей, потоковый чат, выгрузка модели из памяти. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LmModelInfo } from '../src/shared/types';

export class LmStudio {
  constructor(private endpoint: () => string) {}

  private base() { return this.endpoint().replace(/\/+$/, '').replace(/\/(api\/)?v\d+$/, ''); }

  async isOnline(): Promise<boolean> {
    try {
      const r = await fetch(this.base() + '/v1/models', { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  }

  async listModels(): Promise<LmModelInfo[]> {
    try {
      const r = await fetch(this.base() + '/api/v1/models', { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j: any = await r.json();
        const models: any[] = j.models ?? j.data ?? [];
        const out = models
          .filter((m) => !m.type || m.type === 'llm')
          .map((m) => ({ key: String(m.key ?? m.id), name: String(m.display_name ?? m.key ?? m.id), loaded: (m.loaded_instances?.length ?? 0) > 0 || m.state === 'loaded' }));
        if (out.length) return out;
      }
    } catch { /* старые версии LM Studio */ }
    const r = await fetch(this.base() + '/v1/models', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`LM Studio: HTTP ${r.status}`);
    const j: any = await r.json();
    return (j.data ?? []).filter((m: any) => !/embed/i.test(m.id)).map((m: any) => ({ key: m.id, name: m.id, loaded: false }));
  }

  /** Потоковая генерация. onDelta получает весь накопленный текст. Возвращает полный ответ. */
  async streamChat(
    body: { model: string; messages: { role: string; content: string }[]; temperature: number; max_tokens?: number },
    onDelta: (full: string, reasoning: boolean) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(this.base() + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_tokens: 4000, ...body, stream: true }),
        signal,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new Error(`LM Studio недоступен (${this.base()}). Запустите LM Studio и включите сервер (Developer → Start Server).`);
    }
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      throw new Error(`LM Studio: HTTP ${res.status} ${t.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices?.[0]?.delta ?? {};
          if (d.reasoning_content || d.reasoning) onDelta(full, true);
          if (d.content) { full += d.content; onDelta(full, false); }
          if (j.error) throw new Error(String(j.error.message ?? j.error));
        } catch (e) {
          if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
        }
      }
    }
    return full;
  }

  /** Выгрузить модель из памяти: REST v1 (LM Studio 0.4+), иначе CLI `lms unload`. */
  async unload(modelKey: string): Promise<boolean> {
    try {
      const r = await fetch(this.base() + '/api/v1/models', { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j: any = await r.json();
        const ids: string[] = [];
        for (const m of j.models ?? []) {
          for (const inst of m.loaded_instances ?? []) {
            if (m.key === modelKey || inst.id === modelKey || String(inst.id).startsWith(modelKey)) ids.push(inst.id);
          }
        }
        if (!ids.length) return true; // уже не загружена
        let ok = true;
        for (const id of ids) {
          const u = await fetch(this.base() + '/api/v1/models/unload', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance_id: id }), signal: AbortSignal.timeout(15000),
          });
          ok = ok && u.ok;
        }
        if (ok) return true;
      }
    } catch { /* пробуем CLI */ }
    return this.unloadViaCli(modelKey);
  }

  private unloadViaCli(modelKey: string): Promise<boolean> {
    const candidates = [join(homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms'), 'lms'];
    const exe = candidates.find((c) => c === 'lms' || existsSync(c))!;
    return new Promise((resolve) => {
      execFile(exe, ['unload', modelKey], { timeout: 20000, windowsHide: true }, (err) => resolve(!err));
    });
  }
}
