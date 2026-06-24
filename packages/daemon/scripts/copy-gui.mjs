import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'gui');

mkdirSync(out, { recursive: true });
for (const file of ['index.html', 'style.css', 'bootstrap.cjs', 'preload.cjs']) {
  copyFileSync(path.join(root, 'src', 'gui', file), path.join(out, file));
}
