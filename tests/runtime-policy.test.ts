import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canFallbackAfterSideEffect, isImplicitWorkspaceRead, isQuotaError, providerCandidates } from '../src/main/agent/policy.js';

test('quota errors are recognized without treating ordinary failures as quota failures', () => {
  assert.equal(isQuotaError(new Error('Monthly premium request quota exhausted')), true);
  assert.equal(isQuotaError(new Error('HTTP 429: rate limit exceeded')), true);
  assert.equal(isQuotaError(new Error('Invalid tool arguments')), false);
  assert.equal(isQuotaError(new Error('Authentication required')), false);
});

test('provider fallback candidates remain limited to the configured Copilot fallback', () => {
  assert.deepEqual(providerCandidates('copilot', true), ['copilot', 'codebuddy']);
  assert.deepEqual(providerCandidates('copilot', false), ['copilot']);
  assert.deepEqual(providerCandidates('codebuddy', true), ['codebuddy']);
});

test('fallback is blocked after an approved action', () => {
  assert.equal(canFallbackAfterSideEffect(false), true);
  assert.equal(canFallbackAfterSideEffect(true), false);
});

test('only explicit Read actions inside the workspace are implicitly allowed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-agent-policy-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-agent-outside-'));
  try {
    await fs.writeFile(path.join(root, 'inside.txt'), 'ok');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(root, 'external'), 'dir');
    assert.equal(await isImplicitWorkspaceRead('Read', { file_path: 'inside.txt' }, root), true);
    assert.equal(await isImplicitWorkspaceRead('Read', { file_path: 'external/secret.txt' }, root), false);
    assert.equal(await isImplicitWorkspaceRead('Read', { file_path: path.join(outside, 'secret.txt') }, root), false);
    for (const tool of ['Glob', 'Grep', 'LS', 'Skill', 'AskUserQuestion', 'TodoRead', 'TaskGet', 'Unknown']) {
      assert.equal(await isImplicitWorkspaceRead(tool, {}, root), false);
    }
    assert.equal(await isImplicitWorkspaceRead('Read', {}, root), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

import { isSupportedSandboxNodeVersion, isSupportedWasmtimeVersion } from '../src/main/agent/sandbox.js';

test('MXC Node runtime version requirements are platform-specific and fail closed', () => {
  assert.equal(isSupportedSandboxNodeVersion('v24.21.0', 'win32'), true);
  assert.equal(isSupportedSandboxNodeVersion('v24.20.0', 'win32'), false);
  assert.equal(isSupportedSandboxNodeVersion('v24.0.0', 'darwin'), true);
  assert.equal(isSupportedSandboxNodeVersion('v22.13.0', 'darwin'), false);
  assert.equal(isSupportedSandboxNodeVersion('v26.0.0', 'linux'), false);
});

test('bundled Wasmtime version includes the October 2026 security fixes', () => {
  assert.equal(isSupportedWasmtimeVersion('50.0.0'), false);
  assert.equal(isSupportedWasmtimeVersion('50.0.1'), true);
  assert.equal(isSupportedWasmtimeVersion('49.0.5'), false);
  assert.equal(isSupportedWasmtimeVersion('51.0.0'), true);
});
