// Собирает tests/*.test.ts через esbuild и запускает встроенным node:test.
import { build } from 'esbuild';
import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-tests');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.ts'));
await build({
  entryPoints: files.map((f) => join(root, 'tests', f)),
  outdir: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  external: ['electron'],
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['--test', '--test-force-exit', ...files.map((f) => join(out, f.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
process.exit(r.status ?? 1);
