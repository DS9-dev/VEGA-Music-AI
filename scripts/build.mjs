// Сборка VEGA-Music-AI: main/preload (Node) и renderer (React) через esbuild.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const out = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'renderer'), { recursive: true });

// Собранный exe хранит настройки и библиотеку в папке проекта (рядом с исходниками),
// поэтому пересборка не трогает ваши треки. Путь передаётся через resources/root.json.
mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'root.json'), JSON.stringify({ root }, null, 2));

const common = { bundle: true, sourcemap: dev, minify: !dev, logLevel: 'info', absWorkingDir: root };
const meta = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
};

await Promise.all([
  build({
    ...common,
    entryPoints: ['electron/main.ts'],
    outfile: 'dist/main.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    define: meta,
  }),
  build({
    ...common,
    entryPoints: ['electron/preload.ts'],
    outfile: 'dist/preload.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/renderer/main.tsx'],
    outfile: 'dist/renderer/app.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    jsx: 'automatic',
    loader: { '.svg': 'text' },
    define: { ...meta, 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
  }),
]);

copyFileSync(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html'));
if (existsSync(join(root, 'build/icon.png'))) copyFileSync(join(root, 'build/icon.png'), join(out, 'icon.png'));
console.log(`✓ VEGA-Music-AI ${pkg.version} собран`);
