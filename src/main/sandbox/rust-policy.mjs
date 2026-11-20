export const RUST_SOURCE_LIMIT = 64 * 1024;
export const RUST_INPUT_LIMIT = 64 * 1024;
export const SNAPSHOT_FILE_LIMIT = 5000;
export const SNAPSHOT_BYTE_LIMIT = 100 * 1024 * 1024;
export const WASM_FUEL_LIMIT = 100_000_000;
export const WASM_MEMORY_LIMIT = 256 * 1024 * 1024;
export const WASM_RUN_TIMEOUT_MS = 60_000;
export const RUST_BUILD_TIMEOUT_MS = 180_000;

const excludedNames = new Set([
  ".git", ".ssh", ".aws", ".azure", ".kube", ".docker", ".gnupg",
  "node_modules", "target", "dist", "build", "release", "coverage",
  ".next", ".nuxt", ".cache", ".venv", "venv", "__pycache__",
  ".idea", ".vscode", ".desktop-agent", ".config", ".local", ".rustup", ".cargo",
  ".npm", ".mozilla", ".thunderbird", ".pki", ".password-store", ".vscode-server",
  ".cursor", ".claude", ".codebuddy", ".copilot", "library", "appdata",
  "application support", "keychains", "secrets", ".secrets",
  ".terraform", ".pulumi", "out", "vendor", ".turbo", ".parcel-cache",
]);

const excludedFiles = new Set([
  ".npmrc", ".pypirc", ".netrc", ".yarnrc", ".ds_store", ".envrc",
  ".git-credentials", ".credentials", "credentials", "credentials.json",
  "service-account.json", "terraform.tfstate",
]);

export function validateRustSource(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("Rust source must be a non-empty string.");
  }
  if (Buffer.byteLength(source, "utf8") > RUST_SOURCE_LIMIT) {
    throw new Error("Rust source exceeds the 64 KiB limit.");
  }
  return source;
}

export function validateRustInput(input) {
  const value = input === undefined ? {} : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Rust task input must be a JSON object.");
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > RUST_INPUT_LIMIT) {
    throw new Error("Rust task input exceeds the 64 KiB limit.");
  }
  return serialized;
}

export function isSafeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  const parts = normalized.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

export function isExcludedWorkspaceEntry(name, isDirectory) {
  const lowerName = name.toLowerCase();
  if (excludedNames.has(lowerName) || excludedFiles.has(lowerName)) return true;
  if (lowerName === ".env" || lowerName.startsWith(".env.")) return true;
  if (
    lowerName.includes("id_rsa")
    || lowerName.includes("id_ed25519")
    || lowerName.startsWith("ssh_host_")
  ) return true;
  if (!isDirectory && [
    ".pem", ".key", ".p12", ".pfx", ".jks", ".tfstate", ".p8", ".kdbx", ".mobileprovision",
  ].some((suffix) => lowerName.endsWith(suffix))) return true;
  return false;
}

export function buildWasmtimeArgs(wasmtimePath, workspacePath, componentPath) {
  return [
    wasmtimePath,
    "run",
    "--optimize", "pooling-allocator=true",
    "--optimize", "pooling-total-core-instances=4",
    "--optimize", "pooling-total-component-instances=1",
    "--optimize", "pooling-total-memories=1",
    "--optimize", "pooling-total-tables=2",
    "--optimize", "pooling-max-memory-size=" + WASM_MEMORY_LIMIT,
    "--optimize", "pooling-table-elements=100000",
    "--optimize", "pooling-max-component-instance-size=8388608",
    "--optimize", "pooling-max-core-instance-size=8388608",
    "--optimize", "pooling-max-core-instances-per-component=4",
    "--optimize", "pooling-max-memories-per-component=1",
    "--optimize", "pooling-max-tables-per-component=2",
    "--wasm", "fuel=" + WASM_FUEL_LIMIT,
    "--wasm", "max-memory-size=" + WASM_MEMORY_LIMIT,
    "--wasm", "max-instances=4",
    "--wasm", "max-memories=1",
    "--wasm", "max-tables=2",
    "--wasm", "max-table-elements=100000",
    "--wasm", "max-wasm-stack=1048576",
    "--wasm", "timeout=60s",
    "--wasi", "inherit-env=false",
    "--wasi", "inherit-stdin=false",
    "--wasi", "inherit-network=false",
    "--wasi", "allow-ip-name-lookup=false",
    "--wasi", "tcp=false",
    "--wasi", "udp=false",
    "--wasi", "http=false",
    "--wasi", "max-resources=256",
    "--wasi", "hostcall-fuel=10000000",
    "--wasi", "max-component-handles=10000",
    "--wasi", "cwd=/workspace",
    "--dir", workspacePath + "::/workspace",
    componentPath,
  ];
}

export function compareFileHashes(before, after) {
  const changes = [];
  for (const [name, hash] of after) {
    if (before.get(name) !== hash) changes.push({ path: name, status: before.has(name) ? "modified" : "added" });
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changes.push({ path: name, status: "deleted" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
