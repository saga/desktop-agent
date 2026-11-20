import { CopilotClient } from '@github/copilot-sdk';
import type { PermissionRequestInfo } from '../../shared/contracts.js';
import type { ProviderRunInput, ProviderRunResult } from './runtime.js';
import { isImplicitWorkspaceRead } from './policy.js';

let client: CopilotClient | null = null;
let clientStart: Promise<CopilotClient> | null = null;

async function getClient(): Promise<CopilotClient> {
  if (client) return client;
  if (clientStart) return clientStart;
  clientStart = (async () => {
    const instance = new CopilotClient({ mode: 'copilot-cli', useLoggedInUser: true });
    await instance.start();
    client = instance;
    return instance;
  })().catch((error) => { clientStart = null; throw error; });
  return clientStart;
}

function permissionDetails(request: unknown): PermissionRequestInfo {
  const value = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  const kind = typeof value.kind === 'string' ? value.kind : 'tool';
  let detail = '';
  if (kind === 'shell') detail = String(value.fullCommandText ?? value.intention ?? '执行终端命令');
  else if (kind === 'write') {
    detail = String(value.fileName ?? value.intention ?? '写入或修改文件');
    if (typeof value.diff === 'string' && value.diff) detail += '\n\n' + value.diff;
  } else if (kind === 'read') detail = String(value.path ?? value.intention ?? '读取文件');
  else if (kind === 'url') detail = String(value.url ?? value.intention ?? '访问网络资源');
  else if (kind === 'mcp') {
    detail = String(value.serverName ?? 'MCP') + ' / ' + String(value.toolName ?? 'tool');
    const argumentsValue = value.arguments ?? value.input ?? value.toolInput;
    if (argumentsValue && typeof argumentsValue === 'object') {
      try { detail += '\n\n' + JSON.stringify(argumentsValue).slice(0, 12000); } catch { /* omit non-serializable tool arguments */ }
    }
  }
  else detail = String(value.intention ?? kind);
  return { provider: 'copilot', action: kind, description: detail };
}

export async function runCopilot(input: ProviderRunInput): Promise<ProviderRunResult> {
  const instance = await getClient();
  const session = await instance.createSession({
    model: input.model,
    workingDirectory: input.workingDirectory,
    mcpServers: {
      'desktop-agent-sandbox': {
        type: 'local',
        command: input.sandboxMcpServer.command,
        args: input.sandboxMcpServer.args,
        env: input.sandboxMcpServer.env,
        tools: ['run_command', 'execute_rust', 'apply_rust_changes'],
        timeout: 30000,
      },
    },
    onPermissionRequest: async (request) => {
      if (input.isCancelled()) return { kind: 'reject' };
      if (request.kind === 'shell') return { kind: 'reject' };
      const requestRecord = request as unknown as Record<string, unknown>;
      if (request.kind === 'read') {
        if (!await isImplicitWorkspaceRead('Read', { path: requestRecord.path }, input.workingDirectory)) return { kind: 'reject' };
        if (requestRecord.managedApprovalRequired !== true) return { kind: 'approve-once' };
      }
      const allowed = await input.requestPermission(permissionDetails(request));
      if (allowed) input.onSideEffectApproved();
      return { kind: allowed ? 'approve-once' : 'reject' };
    },
  });

  let streamedContent = '';
  const unsubscribeDelta = session.on('assistant.message_delta', (event) => {
    const delta = event.data.deltaContent;
    if (typeof delta === 'string' && delta) { streamedContent += delta; input.onDelta(delta); }
  });
  const unsubscribeIntent = session.on('assistant.intent', (event) => {
    const intent = event.data.intent;
    if (typeof intent === 'string' && intent.trim()) input.onStatus(intent.trim());
  });
  input.setAbort(async () => { await session.abort(); });
  try {
    const response = await session.sendAndWait({ prompt: input.prompt }, 24 * 60 * 60 * 1000);
    return { content: typeof response?.data?.content === 'string' ? response.data.content : streamedContent };
  } finally {
    unsubscribeDelta();
    unsubscribeIntent();
  }
}

export async function stopCopilotClient(): Promise<void> {
  const instance = client;
  client = null;
  clientStart = null;
  if (instance) await instance.stop();
}
