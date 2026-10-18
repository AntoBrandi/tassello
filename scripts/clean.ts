// Removes the folders given, before a build writes them anew
import { rmSync } from 'node:fs';

for (const dir of process.argv.slice(2)) {
  rmSync(dir, { recursive: true, force: true });
}
