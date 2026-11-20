import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(root, "src", "main", "sandbox", "rust-template");
const sdk = path.join(root, "src", "main", "sandbox", "rust-sdk");
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
    "    let _files = ctx.list_files(\"\")?;",
    "    Ok(\"{\\\"ok\\\":true}\".to_string())",
    "}",
    "",
  ].join("\n");
  await fs.writeFile(path.join(project, "src", "agent.rs"), agentSource, "utf8");

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
  console.log("[rust-sandbox] Guest template compiled (" + info.size + " bytes).");
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
