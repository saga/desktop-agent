import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canFallbackAfterSideEffect, isQuotaError, providerCandidates } from '../src/main/agent/policy.js';
import { isInsideWorkspace } from '../src/main/agent/workspace.js';

test('quota and rate-limit failures are recognized for fallback', () => {
  assert.equal(isQuotaError(new Error('Monthly premium request quota exhausted')), true);
  assert.equal(isQuotaError(new Error('HTTP 429: rate limit exceeded')), true);
  assert.equal(isQuotaError(new Error('resource exhausted')), true);
});

test('ordinary execution and authentication failures do not trigger quota fallback', () => {
  assert.equal(isQuotaError(new Error('Invalid tool arguments')), false);
  assert.equal(isQuotaError(new Error('Authentication required')), false);
  assert.equal(isQuotaError(new Error('ENOENT: no such file or directory')), false);
});

test('Copilot may fall back to CodeBuddy, while an explicitly selected CodeBuddy does not wrap around', () => {
  assert.deepEqual(providerCandidates('copilot', true), ['copilot', 'codebuddy']);
  assert.deepEqual(providerCandidates('copilot', false), ['copilot']);
  assert.deepEqual(providerCandidates('codebuddy', true), ['codebuddy']);
});

test('quota fallback is blocked after an approved side-effecting action', () => {
  assert.equal(canFallbackAfterSideEffect(false), true);
  assert.equal(canFallbackAfterSideEffect(true), false);
});

test('workspace validation accepts canonical paths inside the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-agent-workspace-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {};');
    assert.equal(await isInsideWorkspace(root, 'src/index.ts'), true);
    assert.equal(await isInsideWorkspace(root, root), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workspace validation rejects symlink escapes and paths that cannot be resolved', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-agent-workspace-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-agent-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(root, 'external'), 'dir');
    assert.equal(await isInsideWorkspace(root, 'external/secret.txt'), false);
    assert.equal(await isInsideWorkspace(root, 'missing.txt'), false);
    assert.equal(await isInsideWorkspace(root, '../desktop-agent-outside/secret.txt'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});


test('provider fallback is blocked after an approved operation may have side effects', () => {
  assert.equal(canFallbackAfterSideEffect(false), true);
  assert.equal(canFallbackAfterSideEffect(true), false);
});
