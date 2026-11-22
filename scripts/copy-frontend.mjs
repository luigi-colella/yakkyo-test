// Copies the built frontend (`web/dist`) into `api/public`, which the API serves.
import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'web', 'dist');
const destination = path.join(root, 'api', 'public');

if (!existsSync(path.join(source, 'index.html'))) {
  console.error(`No frontend build in ${source}: run "yarn build" in web/ first.`);
  process.exit(1);
}

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
console.log(`Copied ${source} to ${destination}`);
