import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import {
  getPlatformSupport,
  probe,
  spawn,
} from '@microsoft/mxc-sdk/v1';

const workspace = fs.realpathSync(process.env.WORKSPACE_DIR ?? '');
const platform = process.env.HOST_PLATFORM ?? process.platform;
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-mxc-'));
const home = path.resolve(os.homedir());
const secretDirectories = new Set(['.ssh', '.aws', '.azure', '.kube', '.docker', '.gnupg']);
const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => {
  if (!entry) return false;
  const relative = path.relative(home, path.resolve(entry));
  if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return true;
  return !relative.split(path.sep).some((part) => secretDirectories.has(part.toLowerCase()));
});

const readonlyPaths = platform === 'win32'
  ? [...new Set([
      process.env.SystemRoot,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      ...pathEntries,
    ].filter(Boolean))]
  : [...new Set([
      '/System', '/usr', '/bin', '/sbin', '/Library/Developer/CommandLineTools',
      '/opt/homebrew', '/usr/local', ...pathEntries,
    ])];

const filesystem = {
  readwritePaths: [workspace, tempDirectory],
  readonlyPaths,
};
const network = {
  egress: { default: 'deny' },
  ingress: { default: 'deny', hostLoopback: 'deny' },
};
const containment = platform === 'win32'
  ? { type: 'processcontainer' }
  : { type: 'seatbelt' };

const support = getPlatformSupport();
const requiredBackend = platform === 'win32' ? 'processcontainer' : 'seatbelt';
if (!support.isSupported || !support.availableMethods.includes(requiredBackend)) {
  throw new Error(`MXC 后端不可用：${support.reason ?? support.unavailableReasons?.[requiredBackend] ?? requiredBackend}`);
}

const probeRequest = {
  command: platform === 'win32' ? 'cmd.exe /d /c exit 0' : '/usr/bin/true',
  workingDirectory: workspace,
  filesystem,
  network,
  containment,
  inheritDefaultEnvironment: false,
  environment: {
    PATH: process.env.PATH ?? '',
    HOME: tempDirectory,
    TMPDIR: tempDirectory,
    TEMP: tempDirectory,
    TMP: tempDirectory,
    ...(platform === 'win32' ? {
      SystemRoot: process.env.SystemRoot ?? '',
      ComSpec: process.env.ComSpec ?? 'cmd.exe',
    } : {}),
  },
};
if (platform === 'win32') {
  const result = probe(probeRequest);
  if (
    result.error
    || result.tier !== 'base-container'
    || result.needsDaclAugmentation === true
  ) {
    throw new Error(`Windows MXC ProcessContainer 无法在无需管理员操作的条件下提供所需隔离：${result.error ?? 'required host capability is unavailable'}`);
  }
}

const activeProcesses = new Map();
const MAX_OUTPUT_BYTES = 1024 * 1024;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function toolError(id, message) {
  send({
    jsonrpc: '2.0',
    id,
    result: { isError: true, content: [{ type: 'text', text: message }] },
  });
}

async function executeCommand(id, args) {
  if (!args || typeof args.command !== 'string' || !args.command.trim()) {
    return toolError(id, 'command must be a non-empty string');
  }
  if (args.command.length > 20000) return toolError(id, 'command exceeds 20,000 characters');

  const timeoutMs = Number.isInteger(args.timeoutMs)
    ? Math.max(1000, Math.min(args.timeoutMs, 10 * 60 * 1000))
    : 120000;

  const request = {
    ...probeRequest,
    command: args.command,
    timeoutMs,
  };

  let processHandle;
  try {
    processHandle = await spawn(request);
    activeProcesses.set(id, processHandle);
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = (target) => (chunk) => {
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes <= MAX_OUTPUT_BYTES) target.push(buffer);
    };
    processHandle.standardOutput?.on('data', collect(stdout));
    processHandle.standardError?.on('data', collect(stderr));
    const outcome = await processHandle.wait();
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    const suffix = outputBytes > MAX_OUTPUT_BYTES ? '\n[output truncated at 1 MiB]' : '';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        isError: outcome.exitCode !== 0 || outcome.timedOut,
        content: [{
          type: 'text',
          text: [
            `exitCode: ${outcome.exitCode}`,
            `timedOut: ${outcome.timedOut}`,
            out ? `stdout:\n${out}` : '',
            err ? `stderr:\n${err}` : '',
            suffix,
          ].filter(Boolean).join('\n\n'),
        }],
      },
    });
  } catch (error) {
    toolError(id, error instanceof Error ? error.message : String(error));
  } finally {
    activeProcesses.delete(id);
    processHandle?.dispose();
  }
}

const tools = [{
  name: 'run_command',
  description: 'Run a shell command inside the host OS execution sandbox. The working directory is fixed to the approved workspace. Filesystem writes are limited to the workspace and temporary directory; system/toolchain paths are read-only; network access is denied.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute in the isolated workspace.' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, description: 'Execution timeout in milliseconds; defaults to 120000.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
}];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  void (async () => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || message.jsonrpc !== '2.0') return;

    if (message.method === 'notifications/cancelled') {
      const processHandle = activeProcesses.get(message.params?.requestId);
      if (processHandle) {
        try { processHandle.kill(); } catch { /* already exited */ }
      }
      return;
    }

    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'desktop-agent-mxc-sandbox', version: '1.0.0' },
        },
      });
      return;
    }
    if (message.method === 'notifications/initialized') return;
    if (message.method === 'ping') {
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools } });
      return;
    }
    if (message.method === 'tools/call' && message.params?.name === 'run_command') {
      await executeCommand(message.id, message.params.arguments);
      return;
    }
    if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  })().catch((error) => {
    process.stderr.write(`[mxc-mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  });
});

input.on('close', () => {
  for (const processHandle of activeProcesses.values()) {
    try { processHandle.kill(); } catch { /* already exited */ }
    processHandle.dispose();
  }
  try { fs.rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
});
