import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'out', 'sandbox');
await fs.mkdir(destination, { recursive: true });
for (const [sourceName, outputName] of [
  ['mcp-server.mjs', 'mxc-mcp-server.mjs'],
  ['rust-execution.mjs', 'rust-execution.mjs'],
  ['rust-policy.mjs', 'rust-policy.mjs'],
]) {
  await fs.copyFile(
    path.join(root, 'src', 'main', 'sandbox', sourceName),
    path.join(destination, outputName),
  );
}
