import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRustExecutionService } from "../src/main/sandbox/rust-execution.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagedRoot = process.env.DESKTOP_AGENT_RUST_SANDBOX_DIR
  ? path.resolve(process.env.DESKTOP_AGENT_RUST_SANDBOX_DIR)
  : path.join(root, "resources", "rust-sandbox");
const sdk = path.join(packagedRoot, "sdk");
const executable = process.platform === "win32" ? ".exe" : "";
const manifest = JSON.parse(await fs.readFile(path.join(packagedRoot, "manifest.json"), "utf8"));
if (manifest.enabled !== true || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error("Packaged Rust sandbox manifest does not match the current platform/architecture.");
const packagedToolchain = path.join(packagedRoot, "rust-toolchain");
const cargo = path.join(packagedToolchain, "bin", "cargo" + executable);
const rustc = path.join(packagedToolchain, "bin", "rustc" + executable);
const wasmtime = path.join(packagedRoot, "wasmtime", "wasmtime" + executable);
await Promise.all([fs.access(cargo), fs.access(rustc), fs.access(wasmtime)]);
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-agent-rust-check-"));
const workspace = path.join(temporaryRoot, "workspace");
const executionTemp = path.join(temporaryRoot, "execution-temp");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(executionTemp, { recursive: true });
await fs.writeFile(path.join(workspace, "input.txt"), "wasm sandbox works", "utf8");

const agentSource = [
  "use desktop_agent_sdk::AgentContext;",
  "",
  "pub fn run(ctx: &AgentContext) -> Result<String, String> {",
  "    let _input = ctx.input_json()?;",
  "    let files = ctx.list_files(\"\")?;",
  "    if !files.iter().any(|name| name == \"input.txt\") { return Err(\"input file is missing\".to_string()); }",
  "    let content = ctx.read_text(\"input.txt\")?;",
  "    ctx.write_text(\"output.txt\", &content.to_uppercase())?;",
  "    Ok(\"{\\\"ok\\\":true}\".to_string())",
  "}",
  "",
].join("\n");

function spawnForTest(request) {
  const windows = process.platform === "win32";
  const command = windows ? (request.environment.ComSpec || "cmd.exe") : "/bin/sh";
  const args = windows ? ["/d", "/s", "/c", '"' + request.command + '"' ] : ["-c", request.command];
  const child = spawnProcess(command, args, {
    cwd: request.workingDirectory,
    env: request.environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let timedOut = false;
  let timer;
  const waitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? 1, timedOut });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
  });
  return {
    standardOutput: child.stdout,
    standardError: child.stderr,
    wait: () => waitPromise,
    kill: () => child.kill("SIGKILL"),
    dispose: () => undefined,
  };
}

const service = createRustExecutionService({
  workspace,
  tempDirectory: executionTemp,
  platform: process.platform,
  baseRequest: {
    workingDirectory: workspace,
    filesystem: { readwritePaths: [workspace], readonlyPaths: [] },
    network: { egress: { default: "deny" }, ingress: { default: "deny" } },
    environment: {},
  },
  rustToolchainDirectory: packagedToolchain,
  rustSdkDirectory: sdk,
  rustTemplateDirectory: path.join(packagedRoot, "template"),
  wasmtimePath: wasmtime,
  spawn: spawnForTest,
  activeProcesses: new Map(),
  cancelledRequests: new Set(),
  maxOutputBytes: 1024 * 1024,
});

try {
  const execution = await service.execute("rust-wasi-integration", {
    source: agentSource,
    input: { check: true },
  });
  if (execution.isError) throw new Error(execution.content?.[0]?.text ?? "Rust execution service failed.");
  const payload = JSON.parse(execution.content[0].text);
  if (!payload.runId || !Array.isArray(payload.changedFiles)) {
    throw new Error("Rust execution service did not return a snapshot and file diff.");
  }
  if (JSON.parse(payload.result).ok !== true) {
    throw new Error("WASI guest did not write the expected result.");
  }
  if (!payload.changedFiles.some((change) => change.path === "output.txt" && change.status === "added")) {
    throw new Error("Rust execution service did not detect the expected output file.");
  }

  const applied = await service.apply("rust-wasi-apply-integration", {
    runId: payload.runId,
    files: payload.changedFiles,
  });
  if (applied.isError) throw new Error(applied.content?.[0]?.text ?? "Rust snapshot apply failed.");

  const output = await fs.readFile(path.join(workspace, "output.txt"), "utf8");
  if (output !== "WASM SANDBOX WORKS") throw new Error("Approved Rust diff was not applied to the workspace.");
  console.log("[rust-sandbox] Bundled Rust compiler and Wasmtime compiled, executed, diffed, and applied a WASI guest successfully.");
} finally {
  await service.dispose();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
