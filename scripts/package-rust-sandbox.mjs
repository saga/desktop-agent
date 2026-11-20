import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "resources", "rust-sandbox");
const toolchainSource = process.env.DESKTOP_AGENT_RUST_TOOLCHAIN_DIR;
const wasmtimeSource = process.env.DESKTOP_AGENT_WASMTIME_BIN;
const required = process.argv.includes("--require");

await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });

if (!toolchainSource || !wasmtimeSource) {
  const message = "Rust/WASM resources are not configured. Set DESKTOP_AGENT_RUST_TOOLCHAIN_DIR and DESKTOP_AGENT_WASMTIME_BIN.";
  if (required) throw new Error(message);
  await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify({
    enabled: false,
    reason: message,
  }, null, 2) + "\n");
  console.warn("[rust-sandbox] " + message + " The feature will not be available in this build.");
  process.exit(0);
}

const toolchain = path.resolve(toolchainSource);
const wasmtime = path.resolve(wasmtimeSource);
const executable = process.platform === "win32" ? ".exe" : "";
const rustc = path.join(toolchain, "bin", "rustc" + executable);
const cargo = path.join(toolchain, "bin", "cargo" + executable);
const targetLibrary = path.join(toolchain, "lib", "rustlib", "wasm32-wasip2", "lib");

for (const candidate of [rustc, cargo, targetLibrary, wasmtime]) {
  await fs.access(candidate).catch(() => {
    throw new Error("Required Rust/WASM packaging resource is missing: " + candidate);
  });
}

const rustcVersion = execFileSync(rustc, ["--version"], { encoding: "utf8" }).trim();
const wasmtimeVersion = execFileSync(wasmtime, ["--version"], { encoding: "utf8" }).trim();
const rustVersion = /rustc\s+(\d+)\.(\d+)\.(\d+)/.exec(rustcVersion);
const wasmtimeVersionMatch = /wasmtime\s+(\d+)\.(\d+)\.(\d+)/i.exec(wasmtimeVersion);
if (!rustVersion || Number(rustVersion[1]) < 1 || (Number(rustVersion[1]) === 1 && Number(rustVersion[2]) < 85)) {
  throw new Error("Rust 1.85 or later is required for wasm32-wasip2.");
}
if (!wasmtimeVersionMatch || Number(wasmtimeVersionMatch[1]) < 50) {
  throw new Error("Wasmtime 50.0.0 or later is required.");
}
const runHelp = execFileSync(wasmtime, ["run", "--help"], { encoding: "utf8" });
const optimizeHelp = execFileSync(wasmtime, ["run", "-O", "help"], { encoding: "utf8" });
for (const option of ["--dir", "--optimize", "--wasm", "--wasi"]) {
  if (!runHelp.includes(option)) throw new Error("Bundled Wasmtime does not support required option: " + option);
}
for (const option of ["pooling-allocator", "pooling-max-memory-size", "pooling-total-component-instances"]) {
  if (!optimizeHelp.includes(option)) throw new Error("Bundled Wasmtime lacks required pooling option: " + option);
}

const rustTargetDirectory = execFileSync(rustc, ["--print", "target-libdir", "--target", "wasm32-wasip2"], {
  encoding: "utf8",
}).trim();
await fs.access(rustTargetDirectory);

const toolchainDestination = path.join(destination, "rust-toolchain");
await fs.mkdir(toolchainDestination, { recursive: true });
await fs.cp(path.join(toolchain, "bin"), path.join(toolchainDestination, "bin"), { recursive: true, dereference: true });
await fs.cp(path.join(toolchain, "lib"), path.join(toolchainDestination, "lib"), { recursive: true, dereference: true });
const wasmtimeDirectory = path.join(destination, "wasmtime");
await fs.mkdir(wasmtimeDirectory, { recursive: true });
const packagedWasmtime = path.join(wasmtimeDirectory, "wasmtime" + executable);
await fs.copyFile(wasmtime, packagedWasmtime);
await fs.chmod(packagedWasmtime, 0o755);

const sdkSource = path.join(root, "src", "main", "sandbox", "rust-sdk");
const sdkDestination = path.join(destination, "sdk");
await fs.cp(sdkSource, sdkDestination, { recursive: true });
const templateSource = path.join(root, "src", "main", "sandbox", "rust-template");
const templateDestination = path.join(destination, "template");
await fs.cp(templateSource, templateDestination, { recursive: true });

await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify({
  enabled: true,
  rustcVersion,
  wasmtimeVersion,
  target: "wasm32-wasip2",
  sdkVersion: "0.1.0",
}, null, 2) + "\n");

console.log("[rust-sandbox] Packaged " + rustcVersion + " and " + wasmtimeVersion + ".");
