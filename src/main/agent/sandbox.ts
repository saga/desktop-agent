import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export interface SandboxMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function versionAtLeast(version: string, minimum: [number, number, number]): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export function isSupportedSandboxNodeVersion(version: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return versionAtLeast(version, [24, 21, 0]);
  if (platform === 'darwin') return versionAtLeast(version, [24, 0, 0]);
  return false;
}

export function isSupportedWasmtimeVersion(version: string): boolean {
  return versionAtLeast(version, [50, 0, 1]);
}

function nodeCandidates(): string[] {
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  const home = os.homedir();
  const candidates = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executable));

  if (process.platform === 'darwin') {
    candidates.unshift('/opt/homebrew/bin/node', '/usr/local/bin/node', '/opt/local/bin/node');
    candidates.push(
      path.join(home, '.volta', 'bin', 'node'),
      path.join(home, '.asdf', 'shims', 'node'),
      path.join(home, '.fnm', 'aliases', 'default', 'bin', 'node'),
      path.join(home, '.local', 'share', 'mise', 'shims', 'node'),
    );
    for (const entry of ['.nvm/versions/node', '.local/share/fnm/node-versions']) {
      try {
        const root = path.join(home, entry);
        for (const version of fs.readdirSync(root).sort().reverse()) {
          candidates.push(path.join(root, version, 'bin', 'node'));
        }
      } catch {
        // The version manager is optional.
      }
    }
  } else if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles;
    if (programFiles) candidates.unshift(path.join(programFiles, 'nodejs', executable));
  }

  return [...new Set(candidates)];
}

function resolveNode24(): string {
  for (const candidate of nodeCandidates()) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const version = execFileSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      }).trim();
      if (isSupportedSandboxNodeVersion(version, process.platform)) return candidate;
    } catch {
      // Try the next installed Node runtime.
    }
  }

  const requirement = process.platform === 'win32' ? 'Node.js 24.21.0+' : 'Node.js 24+';
  throw new Error(`MXC 隔离执行需要可从应用环境访问的 ${requirement}。未找到兼容版本；不会退回宿主机直接执行 Shell。`);
}

function resolveHelperPath(): string {
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'sandbox', 'mxc-mcp-server.mjs');
  const archive = path.join(process.resourcesPath, 'app.asar');
  if (fs.existsSync(archive)) {
    if (fs.existsSync(unpacked)) return unpacked;
    throw new Error('MXC Sandbox Helper 未正确解包；拒绝从 ASAR 内启动外部 Node 进程。');
  }

  const developmentHelper = path.resolve(moduleDirectory, '../sandbox/mxc-mcp-server.mjs');
  if (fs.existsSync(developmentHelper)) return developmentHelper;
  throw new Error('没有找到 MXC Sandbox Helper。请重新构建或安装应用。');
}

function executionPath(nodePath: string, additionalPaths: string[] = []): string {
  const defaults = process.platform === 'win32'
    ? [
        path.dirname(nodePath),
        process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '',
        process.env.SystemRoot ?? '',
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git', 'cmd') : '',
        process.env.PATH ?? '',
      ]
    : [
        path.dirname(nodePath),
        '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
        process.env.PATH ?? '',
      ];
  return [...new Set([...additionalPaths, ...defaults.filter(Boolean).flatMap((entry) => entry.split(path.delimiter)).filter(Boolean)])]
    .join(path.delimiter);
}


interface RustSandboxResources {
  toolchainDirectory: string;
  sdkDirectory: string;
  templateDirectory: string;
  wasmtimePath: string;
}

function resolveRustSandboxResources(): RustSandboxResources | null {
  const projectRoot = path.resolve(moduleDirectory, "../../../");
  const packagedRoot = path.join(process.resourcesPath, "rust-sandbox");
  const developmentRoot = path.join(projectRoot, "resources", "rust-sandbox");
  const roots = [
    process.env.DESKTOP_AGENT_RUST_SANDBOX_DIR,
    packagedRoot,
    developmentRoot,
  ].filter((value): value is string => Boolean(value));

  const executable = process.platform === "win32" ? ".exe" : "";
  for (const root of [...new Set(roots)]) {
    const toolchainDirectory = process.env.DESKTOP_AGENT_RUST_TOOLCHAIN_DIR
      ? path.resolve(process.env.DESKTOP_AGENT_RUST_TOOLCHAIN_DIR)
      : path.join(root, "rust-toolchain");
    const sdkDirectory = process.env.DESKTOP_AGENT_RUST_SDK_DIR
      ? path.resolve(process.env.DESKTOP_AGENT_RUST_SDK_DIR)
      : path.join(root, "sdk");
    const templateDirectory = process.env.DESKTOP_AGENT_RUST_TEMPLATE_DIR
      ? path.resolve(process.env.DESKTOP_AGENT_RUST_TEMPLATE_DIR)
      : path.join(root, "template");
    const wasmtimePath = process.env.DESKTOP_AGENT_WASMTIME_BIN
      ? path.resolve(process.env.DESKTOP_AGENT_WASMTIME_BIN)
      : path.join(root, "wasmtime", "wasmtime" + executable);
    const rustcPath = path.join(toolchainDirectory, "bin", "rustc" + executable);
    const cargoPath = path.join(toolchainDirectory, "bin", "cargo" + executable);
    const targetLibrary = path.join(toolchainDirectory, "lib", "rustlib", "wasm32-wasip2", "lib");
    if (![rustcPath, cargoPath, targetLibrary, sdkDirectory, path.join(sdkDirectory, "Cargo.toml"), templateDirectory, path.join(templateDirectory, "Cargo.toml"), path.join(templateDirectory, "Cargo.lock"), path.join(templateDirectory, "src", "main.rs"), wasmtimePath]
      .every((candidate) => fs.existsSync(candidate))) continue;

    try {
      const rustVersion = execFileSync(rustcPath, ["--version"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      }).trim();
      const rustMatch = /rustc\s+(\d+)\.(\d+)\.(\d+)/.exec(rustVersion);
      if (!rustMatch || Number(rustMatch[1]) < 1 || (Number(rustMatch[1]) === 1 && Number(rustMatch[2]) < 85)) {
        console.warn("[sandbox] Rust execution disabled: Rust 1.85 or later is required.");
        return null;
      }
      const version = execFileSync(wasmtimePath, ["--version"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      }).trim();
      const match = /wasmtime\s+(\d+)\.(\d+)\.(\d+)/i.exec(version);
      if (!match || Number(match[1]) < 50) {
        console.warn("[sandbox] Rust execution disabled: Wasmtime 50.0.0 or later is required.");
        return null;
      }
      return { toolchainDirectory, sdkDirectory, templateDirectory, wasmtimePath };
    } catch (error) {
      console.warn("[sandbox] Rust execution disabled because the bundled Wasmtime runtime could not start.", error);
      return null;
    }
  }
  return null;
}

export function createSandboxMcpServer(workspaceDirectory: string): SandboxMcpServer {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('MXC Shell 隔离目前只支持 Windows 和 macOS；当前平台不会降级到宿主机执行。');
  }

  const nodePath = resolveNode24();
  const rust = resolveRustSandboxResources();
  return {
    command: nodePath,
    args: [resolveHelperPath()],
    env: {
      PATH: executionPath(nodePath),
      ...(rust ? {
        RUST_TOOLCHAIN_DIR: rust.toolchainDirectory,
        RUST_SDK_DIR: rust.sdkDirectory,
        RUST_TEMPLATE_DIR: rust.templateDirectory,
        WASMTIME_BIN: rust.wasmtimePath,
      } : {}),
      WORKSPACE_DIR: path.resolve(workspaceDirectory),
      HOST_PLATFORM: process.platform,
      NODE_NO_WARNINGS: '1',
    },
  };
}
