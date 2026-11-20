import { query } from '@tencent-ai/agent-sdk';
import type { PermissionRequestInfo } from '../../shared/contracts.js';
import type { ProviderRunInput, ProviderRunResult } from './runtime.js';
import { isInsideWorkspace } from './workspace.js';

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

async function readToolPathAllowed(root: string, toolName: string, toolInput: unknown): Promise<boolean> {
  if (!SAFE_READ_TOOLS.has(toolName)) return true;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return false;
  const input = toolInput as Record<string, unknown>;
  if (toolName === 'Glob') {
    const pattern = typeof input.pattern === 'string' ? input.pattern.replaceAll(String.fromCharCode(92), '/') : '';
    if (!pattern || pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern) || pattern.split('/').includes('..')) return false;
  }
  if (toolName === 'Read') {
    const candidate = typeof input.file_path === 'string' ? input.file_path : input.path;
    return typeof candidate === 'string' && await isInsideWorkspace(root, candidate);
  }
  for (const key of ['file_path', 'path', 'directory', 'search_path', 'cwd']) {
    if (!(key in input)) continue;
    const candidate = input[key];
    if (typeof candidate !== 'string' || !await isInsideWorkspace(root, candidate)) return false;
  }
  return true;
}

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
    description: toolName + (detail ? '\n\n' + detail : ''),
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
      if (input.isCancelled()) return { behavior: 'deny' as const, message: '任务已停止。', interrupt: true };
      if (SAFE_READ_TOOLS.has(toolName) && await readToolPathAllowed(input.workingDirectory, toolName, toolInput)) {
        return { behavior: 'allow' as const, updatedInput: toolInput };
      }
      if (SAFE_READ_TOOLS.has(toolName)) {
        return {
          behavior: 'deny' as const,
          message: '只允许读取当前工作目录内的真实文件。目标不存在、无法验证或位于工作区外时会被拒绝。',
          interrupt: false,
        };
      }
      const allowed = await input.requestPermission(describeToolRequest(toolName, toolInput));
      if (allowed) input.onSideEffectApproved();
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
