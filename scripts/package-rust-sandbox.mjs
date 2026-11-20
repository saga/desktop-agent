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
const wasmtimeVersionParts = wasmtimeVersionMatch?.slice(1).map(Number) ?? [];
if (
  wasmtimeVersionParts.length !== 3
  || wasmtimeVersionParts[0] < 50
  || (wasmtimeVersionParts[0] === 50 && wasmtimeVersionParts[1] === 0 && wasmtimeVersionParts[2] < 1)
) {
  throw new Error("Wasmtime 50.0.1 or later is required (50.0.0 is affected by CVE-2026-126407).");
}
const runHelp = execFileSync(wasmtime, ["run", "--help"], { encoding: "utf8" });
const optimizeHelp = execFileSync(wasmtime, ["run", "-O", "help"], { encoding: "utf8" });
const wasmHelp = execFileSync(wasmtime, ["run", "-W", "help"], { encoding: "utf8" });
const wasiHelp = execFileSync(wasmtime, ["run", "-S", "help"], { encoding: "utf8" });
for (const option of ["--dir", "--optimize", "--wasm", "--wasi"]) {
  if (!runHelp.includes(option)) throw new Error("Bundled Wasmtime does not support required option: " + option);
}
for (const option of [
  "pooling-allocator", "pooling-max-memory-size", "pooling-total-component-instances",
  "pooling-total-core-instances", "pooling-max-component-instance-size",
]) {
  if (!optimizeHelp.includes(option)) throw new Error("Bundled Wasmtime lacks required pooling option: " + option);
}
for (const option of [
  "fuel", "max-memory-size", "max-instances", "max-memories", "max-tables",
  "max-table-elements", "max-wasm-stack", "timeout",
]) {
  if (!wasmHelp.includes(option)) throw new Error("Bundled Wasmtime lacks required WebAssembly limit: " + option);
}
for (const option of [
  "inherit-env", "inherit-stdin", "inherit-network", "allow-ip-name-lookup",
  "tcp", "udp", "http", "max-resources", "hostcall-fuel",
  "max-component-handles", "cwd",
]) {
  if (!wasiHelp.includes(option)) throw new Error("Bundled Wasmtime lacks required WASI policy option: " + option);
}

const rustTargetDirectory = execFileSync(rustc, ["--print", "target-libdir", "--target", "wasm32-wasip2"], {
  encoding: "utf8",
}).trim();
await fs.access(rustTargetDirectory);

const toolchainDestination = path.join(destination, "rust-toolchain");
const toolchainBinDestination = path.join(toolchainDestination, "bin");
await fs.mkdir(toolchainBinDestination, { recursive: true });
for (const name of ["rustc" + executable, "cargo" + executable]) {
  await fs.copyFile(path.join(toolchain, "bin", name), path.join(toolchainBinDestination, name));
}
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

const licenseDestination = path.join(destination, "licenses");
await fs.mkdir(licenseDestination, { recursive: true });
const rustLicenseSource = path.join(toolchain, "share", "doc", "rust", "licenses");
await fs.access(rustLicenseSource).catch(() => {
  throw new Error("Rust toolchain license notices are missing: " + rustLicenseSource);
});
await fs.cp(rustLicenseSource, path.join(licenseDestination, "rust"), { recursive: true });
const wasmtimeLicenseFiles = [];
for (const name of ["LICENSE", "LICENSE-APACHE", "LICENSE-MIT"]) {
  const source = path.join(path.dirname(wasmtime), name);
  try {
    await fs.copyFile(source, path.join(licenseDestination, "wasmtime-" + name));
    wasmtimeLicenseFiles.push("licenses/wasmtime-" + name);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
if (wasmtimeLicenseFiles.length === 0) {
  throw new Error("Wasmtime license notices were not found next to the bundled CLI.");
}

await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify({
  enabled: true,
  rustcVersion,
  wasmtimeVersion,
  target: "wasm32-wasip2",
  sdkVersion: "0.1.0",
  licenseFiles: ["licenses/rust", ...wasmtimeLicenseFiles],
}, null, 2) + "\n");

console.log("[rust-sandbox] Packaged " + rustcVersion + " and " + wasmtimeVersion + ".");
