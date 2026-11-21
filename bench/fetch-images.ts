/**
 * Downloads the benchmark image set listed in images.json into bench/images/.
 * Every file is public domain or CC0; the manifest carries the source page and license.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'images');

interface Manifest {
  agent: string;
  images: { file: string; url: string; license: string; source: string }[];
}

const { default: manifest } = (await import('./images.json', { with: { type: 'json' } })) as {
  default: Manifest;
};

await mkdir(dir, { recursive: true });
for (const image of manifest.images) {
  const target = join(dir, image.file);
  const exists = await stat(target).then(
    (s) => s.size > 0,
    () => false,
  );
  if (exists) {
    console.log(`have    ${image.file}`);
    continue;
  }
  const res = await fetch(image.url, {
    headers: { 'user-agent': `${manifest.agent} (https://konvetto.com; hello@konvetto.com)` },
  });
  if (!res.ok) throw new Error(`${image.url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(target, bytes);
  console.log(`fetched ${image.file} (${(bytes.length / 1024).toFixed(0)} kB, ${image.license})`);
}
