import { query } from '@tencent-ai/agent-sdk';
import type { PermissionRequestInfo } from '../../shared/contracts.js';
import type { ProviderRunInput, ProviderRunResult } from './runtime.js';
import { isImplicitWorkspaceRead } from './policy.js';

function describeToolRequest(toolName: string, toolInput: unknown): PermissionRequestInfo {
  let detail = '';
  try { detail = JSON.stringify(toolInput ?? {}); } catch { detail = String(toolInput ?? ''); }
  return { provider: 'codebuddy', action: toolName, description: toolName + (detail ? '\n\n' + detail : '') };
}

export async function runCodeBuddy(input: ProviderRunInput): Promise<ProviderRunResult> {
  let streamedContent = '';
  const queryOptions = {
    model: input.model,
    cwd: input.workingDirectory,
    // All SDK tools pass through the host callback; unknown tools require approval.
    permissionMode: 'bypassPermissions' as const,
    settingSources: [],
    mcpServers: {
      'desktop-agent-sandbox': {
        type: 'stdio',
        command: input.sandboxMcpServer.command,
        args: input.sandboxMcpServer.args,
        env: input.sandboxMcpServer.env,
        timeout: 30000,
      },
    },
    maxTurns: 20,
    canUseTool: async (toolName: string, toolInput: unknown) => {
      if (input.isCancelled()) return { behavior: 'deny' as const, message: '任务已停止。', interrupt: true };
      if (/^(bash|shell|terminal|powershell|commandprompt|cmd)$/i.test(toolName)) {
        return { behavior: 'deny' as const, message: '宿主机 Shell 已禁用。请使用 desktop-agent-sandbox 的 run_command 工具。', interrupt: false };
      }
      if (await isImplicitWorkspaceRead(toolName, toolInput, input.workingDirectory)) {
        return { behavior: 'allow' as const, updatedInput: toolInput };
      }
      const allowed = await input.requestPermission(describeToolRequest(toolName, toolInput));
      if (allowed) input.onSideEffectApproved();
      return allowed
        ? { behavior: 'allow' as const, updatedInput: toolInput }
        : { behavior: 'deny' as const, message: '用户拒绝了这个操作。请不要重复执行同一动作。', interrupt: false };
    },
  } as NonNullable<Parameters<typeof query>[0]['options']>;

  const agentQuery = query({ prompt: input.prompt, options: queryOptions });
  input.setAbort(async () => { await agentQuery.interrupt(); });
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
        if (item.type === 'text' && typeof item.text === 'string' && item.text) {
          streamedContent += item.text;
          input.onDelta(item.text);
        } else if (item.type === 'tool_use') {
          input.onStatus('CodeBuddy 正在使用 ' + (typeof item.name === 'string' ? item.name : '工具'));
        }
      }
    } else if (raw.type === 'result' && raw.is_error === true) {
      const errorText = typeof raw.result === 'string' ? raw.result
        : typeof raw.error === 'string' ? raw.error : 'CodeBuddy 返回了执行错误。';
      throw new Error(errorText);
    }
  }
  return { content: streamedContent };
}
