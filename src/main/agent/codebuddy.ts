import { query } from '@tencent-ai/agent-sdk';
import type { PermissionRequestInfo } from '../../shared/contracts.js';
import type { ProviderRunInput, ProviderRunResult } from './runtime.js';

const SAFE_READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Skill',
  'AskUserQuestion',
  'TodoRead',
  'TaskGet',
]);

function describeToolRequest(toolName: string, toolInput: unknown): PermissionRequestInfo {
  let detail = '';
  try {
    detail = JSON.stringify(toolInput ?? {});
  } catch {
    detail = String(toolInput ?? '');
  }
  return {
    provider: 'codebuddy',
    action: toolName,
    description: (toolName + (detail ? '\n\n' + detail : '')).slice(0, 2400),
  };
}

export async function runCodeBuddy(input: ProviderRunInput): Promise<ProviderRunResult> {
  let streamedContent = '';
  const queryOptions = {
    model: input.model,
    cwd: input.workingDirectory,
    // The SDK permission bypass is paired with a host-side tool gate below.
    // Mutating or execution tools are never admitted without user approval.
    permissionMode: 'bypassPermissions' as const,
    settingSources: [],
    maxTurns: 20,
    canUseTool: async (toolName: string, toolInput: unknown) => {
      if (SAFE_READ_TOOLS.has(toolName)) {
        return { behavior: 'allow' as const, updatedInput: toolInput };
      }
      const allowed = await input.requestPermission(describeToolRequest(toolName, toolInput));
      return allowed
        ? { behavior: 'allow' as const, updatedInput: toolInput }
        : {
            behavior: 'deny' as const,
            message: '用户拒绝了这个操作。请不要重复执行同一动作。',
            interrupt: false,
          };
    },
  } as NonNullable<Parameters<typeof query>[0]['options']>;

  const agentQuery = query({
    prompt: input.prompt,
    options: queryOptions,
  });

  input.setAbort(async () => {
    await agentQuery.interrupt();
  });

  for await (const message of agentQuery) {
    const raw = message as unknown as Record<string, unknown>;
    if (raw.type === 'assistant') {
      const assistantMessage = raw.message;
      if (!assistantMessage || typeof assistantMessage !== 'object') continue;
      const content = (assistantMessage as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const item = block as Record<string, unknown>;
        if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
          streamedContent += item.text;
          input.onDelta(item.text);
        } else if (item.type === 'tool_use') {
          const toolName = typeof item.name === 'string' ? item.name : '工具';
          input.onStatus('CodeBuddy 正在使用 ' + toolName);
        }
      }
    } else if (raw.type === 'result' && raw.is_error === true) {
      const errorText = typeof raw.result === 'string'
        ? raw.result
        : typeof raw.error === 'string'
          ? raw.error
          : 'CodeBuddy 返回了执行错误。';
      throw new Error(errorText);
    }
  }

  return { content: streamedContent };
}
