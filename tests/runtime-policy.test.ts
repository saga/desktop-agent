import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isQuotaError, providerCandidates } from '../src/main/agent/policy.js';
import { isWorkspacePathAllowed } from '../src/main/agent/workspace.js';

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


test('workspace path validation rejects traversal and symlink escapes', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-path-'));
  const workspace = path.join(temporary, 'workspace');
  const outside = path.join(temporary, 'outside');
  try {
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(workspace, 'inside.txt'), 'inside');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(workspace, 'external'), 'dir');

    assert.equal(await isWorkspacePathAllowed(workspace, 'inside.txt'), true);
    assert.equal(await isWorkspacePathAllowed(workspace, '../outside/secret.txt'), false);
    assert.equal(await isWorkspacePathAllowed(workspace, 'external/secret.txt'), false);
    assert.equal(await isWorkspacePathAllowed(workspace, 'missing.txt'), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
