import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "resources", "rust-sandbox");
const staging = destination + ".staging-" + process.pid;
const toolchainSource = process.env.DESKTOP_AGENT_RUST_TOOLCHAIN_DIR;
const wasmtimeSource = process.env.DESKTOP_AGENT_WASMTIME_BIN;
const required = process.argv.includes("--require");
const supported = new Set(["darwin:arm64", "darwin:x64", "win32:x64"]);
const platformKey = process.platform + ":" + process.arch;
if (!supported.has(platformKey)) {
  throw new Error("Rust sandbox release packaging supports macOS arm64/x64 and Windows x64 only; got " + platformKey);
}
if (!toolchainSource || !wasmtimeSource) {
  const message = "Set DESKTOP_AGENT_RUST_TOOLCHAIN_DIR and DESKTOP_AGENT_WASMTIME_BIN to platform-native toolchain paths.";
  if (required) throw new Error(message);
  console.warn("[rust-sandbox] " + message);
  process.exit(0);
}
const toolchain = path.resolve(toolchainSource);
const wasmtime = path.resolve(wasmtimeSource);
const executable = process.platform === "win32" ? ".exe" : "";
const rustc = path.join(toolchain, "bin", "rustc" + executable);
const cargo = path.join(toolchain, "bin", "cargo" + executable);
const targetLibrary = path.join(toolchain, "lib", "rustlib", "wasm32-wasip2", "lib");
for (const candidate of [rustc, cargo, targetLibrary, wasmtime]) {
  await fs.access(candidate).catch(() => { throw new Error("Required Rust/WASM resource is missing: " + candidate); });
}
const rustcVersion = execFileSync(rustc, ["--version"], { encoding: "utf8" }).trim();
const cargoVersion = execFileSync(cargo, ["--version"], { encoding: "utf8" }).trim();
const wasmtimeVersion = execFileSync(wasmtime, ["--version"], { encoding: "utf8" }).trim();
const rustMatch = /rustc\s+(\d+)\.(\d+)\.(\d+)/.exec(rustcVersion);
const wasmMatch = /wasmtime\s+(\d+)\.(\d+)\.(\d+)/i.exec(wasmtimeVersion);
if (!rustMatch || Number(rustMatch[1]) !== 1 || Number(rustMatch[2]) < 85) throw new Error("Rust 1.85 or later is required.");
const version = wasmMatch?.slice(1).map(Number) ?? [];
if (version.length !== 3 || version[0] < 50 || (version[0] === 50 && version[1] === 0 && version[2] < 1)) {
  throw new Error("Wasmtime 50.0.1 or later is required; 50.0.0 is rejected.");
}
const reportedTarget = execFileSync(rustc, ["--print", "target-libdir", "--target", "wasm32-wasip2"], { encoding: "utf8" }).trim();
if (path.resolve(reportedTarget) !== path.resolve(targetLibrary)) {
  throw new Error("Rust target-libdir does not resolve to the expected wasm32-wasip2 target directory.");
}
await fs.access(reportedTarget);
for (const [command, options] of [["run", ["--help"]], ["run", ["-O", "help"]], ["run", ["-W", "help"]], ["run", ["-S", "help"]]]) {
  execFileSync(wasmtime, options, { encoding: "utf8", stdio: "pipe" });
}
const runHelp = execFileSync(wasmtime, ["run", "--help"], { encoding: "utf8" });
const optimizeHelp = execFileSync(wasmtime, ["run", "-O", "help"], { encoding: "utf8" });
const wasmHelp = execFileSync(wasmtime, ["run", "-W", "help"], { encoding: "utf8" });
const wasiHelp = execFileSync(wasmtime, ["run", "-S", "help"], { encoding: "utf8" });
for (const option of ["--dir", "--optimize", "--wasm", "--wasi"]) if (!runHelp.includes(option)) throw new Error("Wasmtime lacks " + option);
for (const option of ["pooling-allocator", "pooling-max-memory-size", "pooling-total-component-instances", "pooling-total-core-instances", "pooling-max-component-instance-size"]) if (!optimizeHelp.includes(option)) throw new Error("Wasmtime lacks pooling option " + option);
for (const option of ["fuel", "max-memory-size", "max-instances", "max-memories", "max-tables", "max-table-elements", "max-wasm-stack", "timeout"]) if (!wasmHelp.includes(option)) throw new Error("Wasmtime lacks WASM limit " + option);
for (const option of ["inherit-env", "inherit-stdin", "inherit-network", "allow-ip-name-lookup", "tcp", "udp", "http", "max-resources", "hostcall-fuel", "max-component-handles", "cwd"]) if (!wasiHelp.includes(option)) throw new Error("Wasmtime lacks WASI policy option " + option);

await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
try {
  const toolchainOut = path.join(staging, "rust-toolchain");
  await fs.mkdir(path.join(toolchainOut, "bin"), { recursive: true });
  for (const name of ["rustc" + executable, "cargo" + executable]) await fs.copyFile(path.join(toolchain, "bin", name), path.join(toolchainOut, "bin", name));
  await fs.cp(path.join(toolchain, "lib"), path.join(toolchainOut, "lib"), { recursive: true, dereference: true });
  const wasmtimeOut = path.join(staging, "wasmtime");
  await fs.mkdir(wasmtimeOut, { recursive: true });
  const packagedWasmtime = path.join(wasmtimeOut, "wasmtime" + executable);
  await fs.copyFile(wasmtime, packagedWasmtime);
  if (process.platform !== "win32") await fs.chmod(packagedWasmtime, 0o755);
  await fs.cp(path.join(root, "src/main/sandbox/rust-sdk"), path.join(staging, "sdk"), { recursive: true });
  await fs.cp(path.join(root, "src/main/sandbox/rust-template"), path.join(staging, "template"), { recursive: true });
  const licenses = path.join(staging, "licenses");
  await fs.mkdir(licenses, { recursive: true });
  const rustLicenses = path.join(toolchain, "share", "doc", "rust", "licenses");
  await fs.access(rustLicenses);
  await fs.cp(rustLicenses, path.join(licenses, "rust"), { recursive: true });
  let foundWasmtimeLicense = false;
  for (const name of ["LICENSE", "LICENSE-APACHE", "LICENSE-MIT"]) {
    try {
      await fs.copyFile(path.join(path.dirname(wasmtime), name), path.join(licenses, "wasmtime-" + name));
      foundWasmtimeLicense = true;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  if (!foundWasmtimeLicense) throw new Error("Wasmtime license notices were not found beside the executable.");

  const hashes = {};
  async function hashTree(directory, prefix = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await hashTree(absolute, relative);
      else if (entry.isFile()) hashes[relative] = createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
    }
  }
  await hashTree(staging);
  await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, platform: process.platform, arch: process.arch,
    rustcVersion, cargoVersion, wasmtimeVersion, target: "wasm32-wasip2",
    sdkVersion: "0.1.0", templateVersion: "0.1.0", files: hashes,
  }, null, 2) + "\n");
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(staging, destination);
  console.log("[rust-sandbox] Packaged " + platformKey + " / " + rustcVersion + " / " + wasmtimeVersion);
} catch (error) {
  await fs.rm(staging, { recursive: true, force: true });
  throw error;
}
