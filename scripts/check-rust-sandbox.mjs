import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWasmtimeArgs } from "../src/main/sandbox/rust-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(root, "src", "main", "sandbox", "rust-template");
const sdk = path.join(root, "src", "main", "sandbox", "rust-sdk");
const wasmtime = process.env.WASMTIME_BIN;
if (!wasmtime) throw new Error("WASMTIME_BIN is required to run the Rust/WASM integration check.");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-agent-rust-check-"));
const project = path.join(temporaryRoot, "project");

try {
  await fs.cp(template, project, { recursive: true });
  const manifestPath = path.join(project, "Cargo.toml");
  const manifest = (await fs.readFile(manifestPath, "utf8"))
    .replace("__DESKTOP_AGENT_SDK_PATH__", sdk.replace(/\\/g, "/"));
  await fs.writeFile(manifestPath, manifest, "utf8");
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
  await fs.writeFile(path.join(project, "src", "agent.rs"), agentSource, "utf8");
  const workspace = path.join(temporaryRoot, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "input.txt"), "wasm sandbox works", "utf8");
  await fs.mkdir(path.join(workspace, ".desktop-agent"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".desktop-agent", "input.json"), JSON.stringify({ check: true }), "utf8");

  const cargoHome = path.join(temporaryRoot, "cargo-home");
  await fs.mkdir(cargoHome, { recursive: true });
  execFileSync("cargo", [
    "build",
    "--offline",
    "--locked",
    "--release",
    "--target",
    "wasm32-wasip2",
    "--manifest-path",
    manifestPath,
  ], {
    cwd: project,
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_HOME: cargoHome,
      CARGO_NET_OFFLINE: "true",
      CARGO_TERM_COLOR: "never",
    },
  });

  const component = path.join(project, "target", "wasm32-wasip2", "release", "desktop_agent_task.wasm");
  const info = await fs.stat(component);
  if (!info.isFile() || info.size === 0) throw new Error("Rust WASM template did not produce a component.");

  const wasmtimeArgs = buildWasmtimeArgs(wasmtime, workspace, component);
  execFileSync(wasmtime, wasmtimeArgs.slice(1), {
    cwd: project,
    stdio: "inherit",
    env: {
      PATH: path.dirname(wasmtime),
      HOME: temporaryRoot,
      TMPDIR: temporaryRoot,
      WASMTIME_CACHE: path.join(temporaryRoot, "wasmtime-cache"),
    },
  });
  const output = await fs.readFile(path.join(workspace, "output.txt"), "utf8");
  const result = await fs.readFile(path.join(workspace, ".desktop-agent", "result.json"), "utf8");
  if (output !== "WASM SANDBOX WORKS") throw new Error("WASI guest did not write the expected workspace output.");
  if (JSON.parse(result).ok !== true) throw new Error("WASI guest did not write the expected result.");
  console.log("[rust-sandbox] Guest compiled and executed (" + info.size + " bytes); WASI file read/write passed.");
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
