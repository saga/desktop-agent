# Rust/WASM Agent execution

The Rust execution backend is an additional tool on the existing MXC MCP server. It does not replace the native `run_command` path.

## Toolchain preparation

Use a platform-native Rust toolchain (Rust 1.85 or later) with the WASI Preview 2 target installed:

```sh
rustup target add wasm32-wasip2
```

Use Wasmtime 50.0.1 or later. Wasmtime 50.0.0 is rejected because it is affected by CVE-2026-126407. The packaged Wasmtime executable must match the host OS and CPU architecture.

Before packaging, set:

- `DESKTOP_AGENT_RUST_TOOLCHAIN_DIR`: the installed Rust toolchain root containing `bin/rustc`, `bin/cargo`, and `lib/rustlib/wasm32-wasip2/lib`.
- `DESKTOP_AGENT_WASMTIME_BIN`: absolute path to the Wasmtime CLI executable.

macOS shell:

```sh
export DESKTOP_AGENT_RUST_TOOLCHAIN_DIR="$(rustc --print sysroot)"
export DESKTOP_AGENT_WASMTIME_BIN="$(command -v wasmtime)"
npm run package
```

Windows PowerShell:

```powershell
$env:DESKTOP_AGENT_RUST_TOOLCHAIN_DIR = (rustc --print sysroot)
$env:DESKTOP_AGENT_WASMTIME_BIN = (Get-Command wasmtime).Source
npm run package
```

The packaging script accepts only native `darwin-arm64`, `darwin-x64`, and `win32-x64` toolchains, stages resources before replacing the destination, records OS/architecture and SHA-256 hashes in `manifest.json`, and copies the Rust toolchain, Wasmtime, SDK, and fixed project template into Electron `extraResources/rust-sandbox`. Release packaging fails if a required executable, license, target library, or compatible Wasmtime option is missing. The runtime checks the manifest platform and architecture before enabling the Rust tools.

For development, `npm run build` does not copy the large Rust toolchain. To enable the Rust MCP tools locally, set the same environment variables and run `npm run package:rust-sandbox` before starting the app. Without prepared resources, the Rust MCP tools are not registered and the existing MXC command tool continues to work.

Build each release target with its native toolchain/runtime pair. Do not copy a macOS compiler or Wasmtime binary into a Windows package. The macOS build config lists the Rust compiler, Cargo, Rust dylibs/linker, and Wasmtime as additional binaries to sign; validate the resulting Developer ID signature and notarization on a clean Mac. Windows release signing must also Authenticode-sign the bundled Rust and Wasmtime executables.

## Generated module contract

The model supplies only `src/agent.rs`. The host generates Cargo.toml, Cargo.lock, and main.rs from fixed templates. The only Cargo dependency is the local `desktop-agent-sdk`; builds run offline and locked.

The module exports:

```rust
use desktop_agent_sdk::AgentContext;

pub fn run(ctx: &AgentContext) -> Result<String, String> {
    let input = ctx.input_json()?;
    let files = ctx.list_files("")?;
    ctx.log(&format!("Found {} files", files.len()));
    Ok(format!(r#"{{"input":{}}}"#, input))
}
```

SDK operations include `input_json`, `read_text`, `write_text`, `delete_file`, `list_files`, `log`, and `write_result`. Paths are relative to `/workspace`. The SDK has no third-party dependencies.

## Execution and approval

1. `execute_rust` validates source/input sizes and snapshots the selected workspace.
2. Snapshot creation skips symlinks, hard-linked files, credential directories, common secret files, VCS metadata, dependency trees, and build output. The input snapshot is limited to 5,000 files and 100 MiB.
3. Cargo compiles the generated module to `wasm32-wasip2` in MXC. The compiler can write only to the dedicated per-helper temporary root, which contains the active run; the toolchain and SDK are read-only.
4. Wasmtime runs in a separate MXC process. Only the staged workspace is preopened as `/workspace`; no host environment is inherited and no network capability is granted.
5. Wasmtime uses its pooling allocator with one component instance, up to four core instances, one memory and up to two tables, each limited to 100,000 elements, with a 256 MiB maximum linear memory, a 100,000,000 instruction-fuel budget, a 1 MiB Wasm stack, and a 60-second Wasmtime timeout. WASI environment inheritance, stdin, HTTP, TCP, UDP, and DNS lookup are explicitly disabled; host calls have a 10,000,000 fuel budget, the guest may hold at most 256 WASI resources, and component handles are capped at 10,000. MXC also imposes a 60-second wall-clock timeout.
6. The helper returns the result and a file-level `changedFiles` list. Nothing is applied to the real workspace.
7. To apply, the Agent must call `apply_rust_changes` with the exact `runId` and `changedFiles` returned by `execute_rust`. This is a separate provider permission request. The helper checks for concurrent edits and rejects symlink targets before applying.

## Security boundary and current limits

- The generated crate root uses `#![forbid(unsafe_code)]`. Model-supplied Cargo manifests, lockfiles, dependencies, build scripts, and procedural macros are not accepted.
- The Rust compiler and Wasmtime are both launched through MXC. Their writable filesystem scope is the dedicated per-helper temporary root, which contains only the active run and not the real workspace. The native Rust compiler is constrained by source-size and wall-clock limits, but MXC does not impose a hard per-process memory quota. Wasmtime caps guest linear memory at 256 MiB; runtime/host overhead is not a separate OS-enforced memory quota.
- WASI receives one read/write preopen pointing at the snapshot. The Wasmtime process itself is also restricted by MXC, so a WASI preopen escape is still confined to the run directory and read-only toolchain/system paths.
- WASI environment variables are not inherited. WASI network access is not enabled; the outer MXC network policy is default-deny.
- Snapshot size is checked before and after execution, but this first version does not impose a hard filesystem quota while Guest code is running. The 100 MiB limit is a validation/cleanup boundary, not an OS-enforced disk quota.
- Snapshot diffing is file-based. Empty-directory changes are not represented. Symlinks, hard-linked files, and special files are intentionally skipped.
- Windows MXC `base-container` is not an AppContainer or VM. macOS uses Seatbelt. Integration tests on both platforms are required before treating the feature as production-ready.

The Rust backend is opt-in at packaging time and is not advertised when its compiler/runtime resources are absent.


## Build and release verification

CI separates portable source verification from native packaging. Linux runs type-checks, unit tests, and the application build only. Native package jobs build actual Electron artifacts on macOS ARM64, macOS x64, and Windows x64 runners, then upload the DMG/ZIP or NSIS output and report its size. Each package job uses the runner-native Rust toolchain and matching Wasmtime binary; Linux artifacts are not reused for desktop releases.

The CI installers are unsigned test artifacts. A production release still requires organization-owned signing credentials and a release workflow that signs every embedded executable, signs the macOS app, submits it for notarization, staples the ticket, and verifies Gatekeeper/Authenticode status on clean machines. This repository does not claim signing or notarization has occurred merely because an unsigned installer was built. Runtime isolation also needs hands-on testing on supported macOS and Windows versions; CI package success is not a substitute for validating Seatbelt and Windows ProcessContainer behavior on user hardware.
