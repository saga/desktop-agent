import { CopilotClient } from '@github/copilot-sdk';
import type { PermissionRequestInfo } from '../../shared/contracts.js';
import type { ProviderRunInput, ProviderRunResult } from './runtime.js';

let client: CopilotClient | null = null;
let clientStart: Promise<CopilotClient> | null = null;

async function getClient(): Promise<CopilotClient> {
  if (client) return client;
  if (clientStart) return clientStart;

  clientStart = (async () => {
    // Reuse the account already authenticated by the user's local Copilot CLI.
    const instance = new CopilotClient({ mode: 'copilot-cli', useLoggedInUser: true });
    await instance.start();
    client = instance;
    return instance;
  })().catch((error) => {
    clientStart = null;
    throw error;
  });

  return clientStart;
}

function permissionDetails(request: unknown): PermissionRequestInfo {
  const value = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  const kind = typeof value.kind === 'string' ? value.kind : 'tool';
  let detail = '';

  if (kind === 'shell') {
    detail = String(value.fullCommandText ?? value.intention ?? '执行终端命令');
  } else if (kind === 'write') {
    detail = String(value.fileName ?? value.intention ?? '写入或修改文件');
    if (typeof value.diff === 'string' && value.diff) detail += '\n\n' + value.diff.slice(0, 1400);
  } else if (kind === 'read') {
    detail = String(value.path ?? value.intention ?? '读取文件');
  } else if (kind === 'url') {
    detail = String(value.url ?? value.intention ?? '访问网络资源');
  } else if (kind === 'mcp') {
    detail = String(value.serverName ?? 'MCP') + ' / ' + String(value.toolName ?? 'tool');
  } else {
    detail = String(value.intention ?? kind);
  }

  return { provider: 'copilot', action: kind, description: detail.slice(0, 2400) };
}

export async function runCopilot(input: ProviderRunInput): Promise<ProviderRunResult> {
  const instance = await getClient();
  const session = await instance.createSession({
    model: input.model,
    workingDirectory: input.workingDirectory,
    onPermissionRequest: async (request) => {
      // Read-only file access does not modify the workspace; changes and network
      // actions remain behind an explicit host confirmation.
      if (request.kind === 'read') return { kind: 'approve-once' };
      const allowed = await input.requestPermission(permissionDetails(request));
      return { kind: allowed ? 'approve-once' : 'reject' };
    },
  });

  let streamedContent = '';
  const unsubscribeDelta = session.on('assistant.message_delta', (event) => {
    const delta = event.data.deltaContent;
    if (typeof delta === 'string' && delta.length > 0) {
      streamedContent += delta;
      input.onDelta(delta);
    }
  });
  const unsubscribeIntent = session.on('assistant.intent', (event) => {
    const intent = event.data.intent;
    if (typeof intent === 'string' && intent.trim()) input.onStatus(intent.trim());
  });

  input.setAbort(async () => {
    await session.abort();
  });

  try {
    const response = await session.sendAndWait(
      { prompt: input.prompt },
      24 * 60 * 60 * 1000,
    );
    return {
      content: typeof response?.data?.content === 'string'
        ? response.data.content
        : streamedContent,
    };
  } finally {
    unsubscribeDelta();
    unsubscribeIntent();
  }
}

export async function stopCopilotClient(): Promise<void> {
  const instance = client;
  client = null;
  clientStart = null;
  if (instance) {
    await instance.stop();
  }
}
