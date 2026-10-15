import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuotaError, providerCandidates } from '../src/main/agent/policy.js';

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
