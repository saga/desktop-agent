# Rust/WASM Agent execution

The Rust execution backend is an additional tool on the existing MXC MCP server. It does not replace the native `run_command` path.

## Toolchain preparation

Use a platform-native Rust toolchain (Rust 1.85 or later) with the WASI Preview 2 target installed:

```sh
rustup target add wasm32-wasip2
```

Use Wasmtime 50.0.0 or later. The packaged Wasmtime executable must match the host OS and CPU architecture.

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

The packaging script copies the Rust toolchain, Wasmtime, SDK, and fixed project template into Electron `extraResources/rust-sandbox`. Release packaging fails if either executable or the WASM target is missing.

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
    Ok(format!("{{\\"input\\":{}}}", input))
}
```

SDK operations include `input_json`, `read_text`, `write_text`, `delete_file`, `list_files`, `log`, and `write_result`. Paths are relative to `/workspace`. The SDK has no third-party dependencies.

## Execution and approval

1. `execute_rust` validates source/input sizes and snapshots the selected workspace.
2. Snapshot creation skips symlinks, hard-linked files, credential directories, common secret files, VCS metadata, dependency trees, and build output. The input snapshot is limited to 5,000 files and 100 MiB.
3. Cargo compiles the generated module to `wasm32-wasip2` in MXC. The compiler can write only to the current run directory; the toolchain and SDK are read-only.
4. Wasmtime runs in a separate MXC process. Only the staged workspace is preopened as `/workspace`; no host environment is inherited and no network capability is granted.
5. Wasmtime uses its pooling allocator with one component/core instance, one memory and table, a 256 MiB maximum linear memory, a 100,000-element table limit, a 100,000,000 fuel budget, a 1 MiB Wasm stack, and a 60-second Wasmtime timeout. MXC also imposes a 60-second wall-clock timeout.
6. The helper returns the result and a file-level `changedFiles` list. Nothing is applied to the real workspace.
7. To apply, the Agent must call `apply_rust_changes` with the exact `runId` and `changedFiles` returned by `execute_rust`. This is a separate provider permission request. The helper checks for concurrent edits and rejects symlink targets before applying.

## Security boundary and current limits

- The generated crate root uses `#![forbid(unsafe_code)]`. Model-supplied Cargo manifests, lockfiles, dependencies, build scripts, and procedural macros are not accepted.
- The Rust compiler and Wasmtime are both launched through MXC. Their writable filesystem scope is the per-run directory, not the real workspace.
- WASI receives one read/write preopen pointing at the snapshot. The Wasmtime process itself is also restricted by MXC, so a WASI preopen escape is still confined to the run directory and read-only toolchain/system paths.
- WASI environment variables are not inherited. WASI network access is not enabled; the outer MXC network policy is default-deny.
- Snapshot size is checked before and after execution, but this first version does not impose a hard filesystem quota while Guest code is running. The 100 MiB limit is a validation/cleanup boundary, not an OS-enforced disk quota.
- Snapshot diffing is file-based. Empty-directory changes are not represented. Symlinks, hard-linked files, and special files are intentionally skipped.
- Windows MXC `base-container` is not an AppContainer or VM. macOS uses Seatbelt. Integration tests on both platforms are required before treating the feature as production-ready.

The Rust backend is opt-in at packaging time and is not advertised when its compiler/runtime resources are absent.
