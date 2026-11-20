import type { AgentProvider, PermissionRequestInfo } from '../../shared/contracts.js';
import { runCodeBuddy } from './codebuddy.js';
import { runCopilot } from './copilot.js';
import { canFallbackAfterSideEffect, isQuotaError, providerCandidates } from './policy.js';
import type { SandboxMcpServer } from './sandbox.js';

export interface ProviderRunInput {
  prompt: string;
  model: string;
  workingDirectory: string;
  sandboxMcpServer: SandboxMcpServer;
  onDelta: (delta: string) => void;
  onStatus: (status: string) => void;
  requestPermission: (request: PermissionRequestInfo) => Promise<boolean>;
  onSideEffectApproved: () => void;
  isCancelled: () => boolean;
  setAbort: (abort: () => Promise<void>) => void;
}

export interface ProviderRunResult {
  content: string;
}

export interface RuntimeExecutionInput {
  preferredProvider: AgentProvider;
  fallbackOnQuota: boolean;
  models: Record<AgentProvider, string>;
  prompt: string;
  workingDirectory: string;
  sandboxMcpServer: SandboxMcpServer;
  onProvider: (provider: AgentProvider, model: string) => void;
  onStatus: (status: string) => void;
  onDelta: (delta: string) => void;
  onFallback: (from: AgentProvider, to: AgentProvider, error: unknown) => Promise<void> | void;
  requestPermission: (request: PermissionRequestInfo) => Promise<boolean>;
  isCancelled: () => boolean;
  setAbort: (abort: () => Promise<void>) => void;
}

export interface RuntimeExecutionResult extends ProviderRunResult {
  provider: AgentProvider;
  model: string;
}

export async function executeWithFallback(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult> {
  const candidates = providerCandidates(input.preferredProvider, input.fallbackOnQuota);
  let sideEffectApproved = false;

  for (let index = 0; index < candidates.length; index += 1) {
    const provider = candidates[index];
    const model = input.models[provider];
    input.onProvider(provider, model);
    input.onStatus(
      provider === 'copilot'
        ? '正在连接 GitHub Copilot…'
        : '正在连接 CodeBuddy…',
    );

    const providerInput: ProviderRunInput = {
      prompt: input.prompt,
      model,
      workingDirectory: input.workingDirectory,
      sandboxMcpServer: input.sandboxMcpServer,
      onDelta: input.onDelta,
      onStatus: input.onStatus,
      requestPermission: input.requestPermission,
      onSideEffectApproved: () => {
        sideEffectApproved = true;
      },
      isCancelled: input.isCancelled,
      setAbort: input.setAbort,
    };

    try {
      const result = provider === 'copilot'
        ? await runCopilot(providerInput)
        : await runCodeBuddy(providerInput);
      return { ...result, provider, model };
    } catch (error) {
      const nextProvider = candidates[index + 1];
      if (!nextProvider || !isQuotaError(error)) throw error;
      if (!canFallbackAfterSideEffect(sideEffectApproved)) {
        throw new Error(
          '当前 Provider 在执行过程中已获准执行可能产生副作用的操作，额度错误后已停止自动切换，避免重复执行。请检查任务的部分执行结果，再决定是否继续。',
          { cause: error },
        );
      }
      await input.onFallback(provider, nextProvider, error);
    }
  }

  throw new Error('没有可用的 Agent 运行时。');
}
