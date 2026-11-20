import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  RUST_BUILD_TIMEOUT_MS,
  RUST_SOURCE_LIMIT,
  SNAPSHOT_BYTE_LIMIT,
  SNAPSHOT_FILE_LIMIT,
  WASM_RUN_TIMEOUT_MS,
  buildWasmtimeArgs,
  compareFileHashes,
  isExcludedWorkspaceEntry,
  isSafeRelativePath,
  validateRustInput,
  validateRustSource,
} from "./rust-policy.mjs";

function hash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function commandPath(value, platform) {
  if (typeof value !== "string" || !value || /["\r\n]/.test(value)) {
    throw new Error("Rust sandbox executable path is invalid.");
  }
  if (platform === "win32" && /[%!&|<>^]/.test(value)) {
    throw new Error("Rust sandbox executable path contains unsupported shell characters.");
  }
  return platform === "win32" ? '"' + value + '"' : "'" + value.replace(/'/g, "'\\''") + "'";
}

async function scanTree(root, options = {}) {
  const files = new Map();
  let totalBytes = 0;

  async function visit(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".desktop-agent" || isExcludedWorkspaceEntry(entry.name, entry.isDirectory())) continue;
      const source = path.join(directory, entry.name);
      const relative = relativeDirectory ? relativeDirectory + "/" + entry.name : entry.name;
      const info = await fs.lstat(source);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(source, relative);
        continue;
      }
      if (!info.isFile() || info.nlink > 1) continue;
      if (!isSafeRelativePath(relative)) continue;
      if (info.size > SNAPSHOT_BYTE_LIMIT || totalBytes + info.size > SNAPSHOT_BYTE_LIMIT) {
        throw new Error("Workspace snapshot exceeds the 100 MiB limit.");
      }
      if (files.size >= SNAPSHOT_FILE_LIMIT) {
        throw new Error("Workspace snapshot exceeds the 5,000 file limit.");
      }
      const real = await fs.realpath(source);
      if (!inside(root, real)) continue;
      const bytes = await fs.readFile(source);
      if (totalBytes + bytes.length > SNAPSHOT_BYTE_LIMIT) {
        throw new Error("Workspace snapshot exceeds the 100 MiB limit.");
      }
      totalBytes += bytes.length;
      let fileHash = hash(bytes);
      if (options.destination) {
        const destination = path.join(options.destination, ...relative.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
        const copied = await fs.readFile(destination);
        if (hash(copied) !== fileHash) {
          throw new Error("Workspace changed while its snapshot was being created: " + relative);
        }
      }
      files.set(relative, { hash: fileHash, size: bytes.length, source });
    }
  }

  await visit(root, "");
  return files;
}

async function ensureSafeTarget(root, relative, allowMissing = true) {
  if (!isSafeRelativePath(relative)) throw new Error("Workspace change contains an invalid path.");
  const target = path.resolve(root, ...relative.split("/"));
  if (!inside(root, target) || target === root) throw new Error("Workspace change escapes the selected workspace.");
  const parts = relative.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) throw new Error("Workspace change traverses a symbolic link: " + relative);
      if (index < parts.length - 1 && !info.isDirectory()) {
        throw new Error("Workspace change parent is not a directory: " + relative);
      }
      if (index === parts.length - 1 && !info.isFile()) {
        throw new Error("Workspace change target is not a regular file: " + relative);
      }
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissing) break;
      throw error;
    }
  }
  return target;
}

function buildCargoManifest(sdkDirectory, template) {
  const sdkPath = sdkDirectory.replace(/\\/g, "/");
  if (!template.includes("__DESKTOP_AGENT_SDK_PATH__")) {
    throw new Error("Rust Cargo template is missing the SDK path placeholder.");
  }
  return template.replace("__DESKTOP_AGENT_SDK_PATH__", sdkPath.replace(/"/g, '\\"'));
}
function toolResult(value, isError = false) {
  return { isError, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export function createRustExecutionService(options) {
  const {
    workspace,
    tempDirectory,
    platform,
    baseRequest,
    rustToolchainDirectory,
    rustSdkDirectory,
    rustTemplateDirectory,
    wasmtimePath,
    spawn,
    activeProcesses,
    cancelledRequests,
    maxOutputBytes,
  } = options;

  const snapshots = new Map();
  const snapshotRoot = path.join(os.tmpdir(), "desktop-agent-rust-snapshots-" + randomUUID());
  let mutationInProgress = false;
  const rustcPath = path.join(rustToolchainDirectory, "bin", platform === "win32" ? "rustc.exe" : "rustc");
  const cargoPath = path.join(rustToolchainDirectory, "bin", platform === "win32" ? "cargo.exe" : "cargo");
  const toolPathEntries = [
    path.join(rustToolchainDirectory, "bin"),
    path.dirname(wasmtimePath),
    ...(platform === "win32" ? [
      process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : "",
      process.env.SystemRoot ?? "",
    ] : []),
  ].filter(Boolean);
  const toolPath = [...new Set(toolPathEntries)].join(path.delimiter);
  const systemReadonlyPaths = platform === "win32"
    ? [process.env.SystemRoot, process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : ""]
    : ["/System", "/usr", "/bin", "/sbin"];
  const isolatedReadonlyPaths = [...new Set([
    ...systemReadonlyPaths.filter(Boolean),
    rustToolchainDirectory,
    rustSdkDirectory,
    path.dirname(wasmtimePath),
  ])];

  async function runMxc(requestId, command, runDirectory, timeoutMs) {
    if (cancelledRequests.has(requestId)) throw new Error("Rust execution was cancelled.");
    const homeDirectory = path.join(runDirectory, "home");
    const tempPath = path.join(runDirectory, "tmp");
    const cargoHome = path.join(runDirectory, "cargo-home");
    await Promise.all([
      fs.mkdir(homeDirectory, { recursive: true }),
      fs.mkdir(tempPath, { recursive: true }),
      fs.mkdir(cargoHome, { recursive: true }),
    ]);

    const request = {
      ...baseRequest,
      command,
      workingDirectory: runDirectory,
      timeoutMs,
      filesystem: {
        readwritePaths: [tempDirectory],
        readonlyPaths: isolatedReadonlyPaths,
      },
      network: {
        egress: { default: "deny" },
        ingress: { default: "deny", hostLoopback: "deny" },
      },
      inheritDefaultEnvironment: false,
      environment: {
        PATH: toolPath,
        HOME: homeDirectory,
        TMPDIR: tempPath,
        TEMP: tempPath,
        TMP: tempPath,
        CARGO_HOME: cargoHome,
        CARGO_NET_OFFLINE: "true",
        CARGO_TERM_COLOR: "never",
        RUSTC: rustcPath,
        RUSTFLAGS: "-C panic=abort",
        NODE_NO_WARNINGS: "1",
        ...(platform === "win32" ? {
          SystemRoot: process.env.SystemRoot ?? "",
          ComSpec: process.env.ComSpec ?? "cmd.exe",
        } : {}),
      },
    };

    let handle;
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let storedBytes = 0;
    const collect = (target) => (chunk) => {
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.length;
      const remaining = Math.max(0, maxOutputBytes - storedBytes);
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        target.push(kept);
        storedBytes += kept.length;
      }
    };

    try {
      handle = await spawn(request);
      activeProcesses.set(requestId, handle);
      handle.standardOutput?.on("data", collect(stdout));
      handle.standardError?.on("data", collect(stderr));
      const outcome = await handle.wait();
      return {
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        outputBytes,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
    } finally {
      if (activeProcesses.get(requestId) === handle) activeProcesses.delete(requestId);
      handle?.dispose();
    }
  }

  async function execute(requestId, args) {
    if (mutationInProgress) return toolResult("Another Rust sandbox operation is already running.", true);
    mutationInProgress = true;
    let runDirectory;
    try {
      if (!args || typeof args !== "object") throw new Error("Invalid execute_rust arguments.");
      const source = validateRustSource(args.source);
      const inputJson = validateRustInput(args.input);
      await fs.mkdir(snapshotRoot, { recursive: true });
      runDirectory = path.join(tempDirectory, "rust-" + randomUUID());
      const projectDirectory = path.join(runDirectory, "project");
      const stagedWorkspace = path.join(runDirectory, "workspace");
      await Promise.all([
        fs.mkdir(projectDirectory, { recursive: true }),
        fs.mkdir(stagedWorkspace, { recursive: true }),
      ]);

      const canonicalWorkspace = await fs.realpath(workspace);
      const before = await scanTree(canonicalWorkspace, { destination: stagedWorkspace });
      await fs.mkdir(path.join(stagedWorkspace, ".desktop-agent"), { recursive: true });
      await fs.writeFile(path.join(stagedWorkspace, ".desktop-agent", "input.json"), inputJson, "utf8");

      await fs.mkdir(path.join(projectDirectory, "src"), { recursive: true });
      const [manifestTemplate, lockTemplate, mainTemplate] = await Promise.all([
        fs.readFile(path.join(rustTemplateDirectory, "Cargo.toml"), "utf8"),
        fs.readFile(path.join(rustTemplateDirectory, "Cargo.lock"), "utf8"),
        fs.readFile(path.join(rustTemplateDirectory, "src", "main.rs"), "utf8"),
      ]);
      await Promise.all([
        fs.writeFile(path.join(projectDirectory, "Cargo.toml"), buildCargoManifest(rustSdkDirectory, manifestTemplate), "utf8"),
        fs.writeFile(path.join(projectDirectory, "Cargo.lock"), lockTemplate, "utf8"),
        fs.writeFile(path.join(projectDirectory, "src", "main.rs"), mainTemplate, "utf8"),
        fs.writeFile(path.join(projectDirectory, "src", "agent.rs"), source, "utf8"),
      ]);

      const cargoCommand = commandPath(cargoPath, platform)
        + " build --offline --locked --release --target wasm32-wasip2 --manifest-path "
        + commandPath(path.join(projectDirectory, "Cargo.toml"), platform);
      const build = await runMxc(requestId, cargoCommand, runDirectory, RUST_BUILD_TIMEOUT_MS);
      if (build.exitCode !== 0 || build.timedOut) {
        const details = [build.stdout, build.stderr].filter(Boolean).join("\n").slice(0, maxOutputBytes);
        throw new Error("Rust compilation failed" + (build.timedOut ? " (timeout)" : "") + ".\n" + details);
      }

      const componentPath = path.join(projectDirectory, "target", "wasm32-wasip2", "release", "desktop_agent_task.wasm");
      const componentInfo = await fs.stat(componentPath);
      if (!componentInfo.isFile() || componentInfo.size === 0 || componentInfo.size > 32 * 1024 * 1024) {
        throw new Error("Rust compiler produced an invalid or oversized WASM component.");
      }

      const wasmtimeArgs = buildWasmtimeArgs(wasmtimePath, stagedWorkspace, componentPath);
      const runCommand = wasmtimeArgs.map((value) => commandPath(value, platform)).join(" ");
      const execution = await runMxc(requestId, runCommand, runDirectory, WASM_RUN_TIMEOUT_MS);
      if (cancelledRequests.has(requestId)) throw new Error("Rust execution was cancelled.");
      if (execution.exitCode !== 0 || execution.timedOut) {
        const details = [execution.stdout, execution.stderr].filter(Boolean).join("\n").slice(0, maxOutputBytes);
        throw new Error("WASM execution failed" + (execution.timedOut ? " (timeout)" : "") + ".\n" + details);
      }

      const after = await scanTree(stagedWorkspace);
      const changes = compareFileHashes(
        new Map([...before].map(([name, value]) => [name, value.hash])),
        new Map([...after].map(([name, value]) => [name, value.hash])),
      );
      const resultPath = path.join(stagedWorkspace, ".desktop-agent", "result.json");
      let result = "";
      try {
        result = (await fs.readFile(resultPath, "utf8")).slice(0, 64 * 1024);
      } catch {
        result = "";
      }

      if (snapshots.size >= 10) {
        const oldest = snapshots.keys().next().value;
        if (oldest) {
          const old = snapshots.get(oldest);
          snapshots.delete(oldest);
          await fs.rm(old.directory, { recursive: true, force: true });
        }
      }
      const runId = randomUUID();
      const snapshotDirectory = path.join(snapshotRoot, runId);
      await fs.rename(runDirectory, snapshotDirectory);
      const savedWorkspace = path.join(snapshotDirectory, "workspace");
      snapshots.set(runId, {
        directory: snapshotDirectory,
        stagedWorkspace: savedWorkspace,
        workspace: canonicalWorkspace,
        before: new Map([...before].map(([name, value]) => [name, value.hash])),
        after: new Map([...after].map(([name, value]) => [name, value.hash])),
        changes,
      });
      runDirectory = undefined;
      return toolResult({
        runId,
        changedFiles: changes,
        result,
        logs: [execution.stdout, execution.stderr].filter(Boolean).join("\n").slice(0, 16 * 1024),
        note: changes.length
          ? "Changes are isolated in a snapshot. Call apply_rust_changes with this runId and the exact changedFiles list to request a separate approval."
          : "No workspace files changed. No apply step is necessary.",
      });
    } catch (error) {
      if (runDirectory) await fs.rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
      return toolResult(error instanceof Error ? error.message : String(error), true);
    } finally {
      mutationInProgress = false;
    }
  }

  async function apply(requestId, args) {
    if (mutationInProgress) return toolResult("Another Rust sandbox operation is already running.", true);
    mutationInProgress = true;
    const runId = typeof args?.runId === "string" ? args.runId : "";
    const snapshot = snapshots.get(runId);
    if (!snapshot) {
      mutationInProgress = false;
      return toolResult("Rust execution snapshot was not found or has expired.", true);
    }
    try {
      if (cancelledRequests.has(requestId)) throw new Error("Rust diff application was cancelled.");
      const supplied = Array.isArray(args?.files) ? args.files : [];
      if (supplied.length > SNAPSHOT_FILE_LIMIT) throw new Error("Requested Rust diff contains too many paths.");
      const expected = snapshot.changes;
      const normalize = (items) => items
        .map((item) => ({ path: item?.path, status: item?.status }))
        .sort((a, b) => String(a.path).localeCompare(String(b.path)));
      if (JSON.stringify(normalize(supplied)) !== JSON.stringify(normalize(expected))) {
        throw new Error("The requested file list does not match the stored execution diff.");
      }
      if (!expected.length) {
        snapshots.delete(runId);
        await fs.rm(snapshot.directory, { recursive: true, force: true });
        return toolResult({ applied: [], message: "There are no changes to apply." });
      }

      const current = await scanTree(snapshot.workspace);
      for (const change of expected) {
        if (cancelledRequests.has(requestId)) throw new Error("Rust diff application was cancelled.");
        const currentHash = current.get(change.path)?.hash;
        const beforeHash = snapshot.before.get(change.path);
        if (currentHash !== beforeHash) {
          throw new Error("Workspace changed after the Rust snapshot was created; refusing to overwrite: " + change.path);
        }
        const target = await ensureSafeTarget(snapshot.workspace, change.path, true);
        if (change.status !== "deleted") {
          const staged = path.join(snapshot.stagedWorkspace, ...change.path.split("/"));
          const stagedInfo = await fs.lstat(staged);
          if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink()) {
            throw new Error("Staged file is not a regular file: " + change.path);
          }
          const stagedHash = hash(await fs.readFile(staged));
          if (stagedHash !== snapshot.after.get(change.path)) {
            throw new Error("Staged file changed after execution: " + change.path);
          }
        }
      }

      const operations = expected.map((change) => ({
        ...change,
        target: path.resolve(snapshot.workspace, ...change.path.split("/")),
      }));
      const applied = [];
      const backups = [];
      try {
        for (const change of operations) {
          if (cancelledRequests.has(requestId)) throw new Error("Rust diff application was cancelled.");
          const target = change.target;
          await ensureSafeTarget(snapshot.workspace, change.path, true);
          const currentInfo = await fs.lstat(target).catch((error) => {
            if (error?.code === "ENOENT") return null;
            throw error;
          });
          if (currentInfo?.isSymbolicLink() || (currentInfo && !currentInfo.isFile())) {
            throw new Error("Workspace target is no longer a regular file: " + change.path);
          }
          if (currentInfo) {
            const currentRealPath = await fs.realpath(target);
            if (!inside(snapshot.workspace, currentRealPath)) {
              throw new Error("Workspace target resolves outside the selected workspace: " + change.path);
            }
          }
          const currentBytes = currentInfo ? await fs.readFile(target) : null;
          const currentHash = currentBytes ? hash(currentBytes) : undefined;
          if (currentHash !== snapshot.before.get(change.path)) {
            throw new Error("Workspace changed immediately before applying the Rust diff: " + change.path);
          }
          if (change.status === "deleted") {
            const backup = path.join(snapshot.directory, "backups", ...change.path.split("/"));
            await fs.mkdir(path.dirname(backup), { recursive: true });
            await fs.copyFile(target, backup);
            backups.push({ target, backup, existed: true });
            await fs.rm(target);
          } else {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await ensureSafeTarget(snapshot.workspace, change.path, true);
            const exists = await fs.lstat(target).then((info) => info.isFile() && !info.isSymbolicLink()).catch((error) => {
              if (error?.code === "ENOENT") return false;
              throw error;
            });
            let backup;
            if (exists) {
              backup = path.join(snapshot.directory, "backups", ...change.path.split("/"));
              await fs.mkdir(path.dirname(backup), { recursive: true });
              await fs.copyFile(target, backup);
            }
            backups.push({ target, backup, existed: exists });
            const staged = path.join(snapshot.stagedWorkspace, ...change.path.split("/"));
            const temporary = target + ".desktop-agent-" + randomUUID() + ".tmp";
            await fs.copyFile(staged, temporary);
            await fs.rename(temporary, target);
          }
          applied.push(change.path);
        }
      } catch (error) {
        for (const backup of backups.reverse()) {
          try {
            if (backup.existed && backup.backup) {
              await fs.mkdir(path.dirname(backup.target), { recursive: true });
              await fs.copyFile(backup.backup, backup.target);
            } else {
              await fs.rm(backup.target, { force: true });
            }
          } catch {
            // Preserve the original apply error; rollback failures are surfaced in the result.
          }
        }
        throw new Error("Could not apply all Rust changes; rollback was attempted. " + (error instanceof Error ? error.message : String(error)));
      }

      snapshots.delete(runId);
      await fs.rm(snapshot.directory, { recursive: true, force: true });
      return toolResult({ applied, message: "Approved Rust snapshot changes were applied." });
    } catch (error) {
      return toolResult(error instanceof Error ? error.message : String(error), true);
    } finally {
      mutationInProgress = false;
    }
  }

  async function dispose() {
    for (const snapshot of snapshots.values()) {
      await fs.rm(snapshot.directory, { recursive: true, force: true }).catch(() => undefined);
    }
    snapshots.clear();
    await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  const tools = [
    {
      name: "execute_rust",
      description: "Compile and run one LLM-generated Rust module as a WASI Preview 2 component. The host supplies a fixed manifest and SDK; the guest sees only a staged workspace at /workspace. Changes are not applied to the real workspace by this tool.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", maxLength: RUST_SOURCE_LIMIT, description: "Rust module source. It must export pub fn run(ctx: &AgentContext) -> Result<String, String>." },
          input: { type: "object", description: "JSON task input made available through AgentContext::input_json().", additionalProperties: true },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
    {
      name: "apply_rust_changes",
      description: "Apply a previously generated Rust execution snapshot after separate user approval. Supply the exact runId and changedFiles returned by execute_rust.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                status: { type: "string", enum: ["added", "modified", "deleted"] },
              },
              required: ["path", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["runId", "files"],
        additionalProperties: false,
      },
    },
  ];

  return { tools, execute, apply, dispose };
}
