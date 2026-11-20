import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'out', 'sandbox');
await fs.mkdir(destination, { recursive: true });
await fs.copyFile(
  path.join(root, 'src', 'main', 'sandbox', 'mcp-server.mjs'),
  path.join(destination, 'mxc-mcp-server.mjs'),
);
