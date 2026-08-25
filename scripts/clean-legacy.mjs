import { rm } from 'node:fs/promises';

const stale = [
  'lib/demo.ts',
  'app/api/game/attack/route.ts',
];

for (const path of stale) {
  await rm(path, { force: true });
}
