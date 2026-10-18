// tassello create-plugin <folder>: a new plugin, from the template (template/
// in Tassello's package), with an example widget and server side to start from

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { tasselloRoot } from './util.ts';

// npm leaves .gitignore files out of packages: the template's is _gitignore
const RENAMED: Record<string, string> = { _gitignore: '.gitignore' };
const TEXT = new Set(['.json', '.md', '.ts', '.tsx', '.css', '.html', '']);
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

async function copy(from: string, to: string, replacements: Record<string, string>): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const source = path.join(from, entry.name);
    const target = path.join(to, RENAMED[entry.name] ?? entry.name);
    if (entry.isDirectory()) {
      await copy(source, target, replacements);
    } else if (TEXT.has(path.extname(entry.name)) || entry.name in RENAMED) {
      let text = await fs.readFile(source, 'utf8');
      for (const [placeholder, value] of Object.entries(replacements)) {
        text = text.replaceAll(placeholder, value);
      }
      await fs.writeFile(target, text);
    } else {
      await fs.copyFile(source, target);
    }
  }
}

export async function createPlugin(folder: string, name: string | undefined, tasselloVersion: string): Promise<void> {
  const target = path.resolve(folder);
  const existing = await fs.readdir(target).catch(() => null);
  if (existing && existing.length > 0) {
    throw new Error(`${target} is not empty`);
  }
  const base = path.basename(target).toLowerCase();
  const packageName = name ?? (base.startsWith('tassello-plugin-') ? base : `tassello-plugin-${base}`);
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(`"${packageName}" is not a valid npm package name: choose one with --name`);
  }
  await copy(path.join(tasselloRoot(), 'template'), target, {
    __PLUGIN_NAME__: packageName,
    __TASSELLO_VERSION__: tasselloVersion,
  });
  const relative = path.relative(process.cwd(), target);
  const shown = relative.startsWith('..') ? target : relative || '.';
  console.log(`Created the plugin ${packageName} in ${target}. Next:

  cd ${shown}
  npm install
  npm run build
  tassello --plugin .

then add its widget to a panel (Edit, Add widget). See README.md there.`);
}
