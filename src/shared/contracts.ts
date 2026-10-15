export type AgentProvider = 'copilot' | 'codebuddy';

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'stopped';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  provider?: AgentProvider;
  model?: string;
  status?: MessageStatus;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface AgentSettings {
  preferredProvider: AgentProvider;
  copilotModel: string;
  codebuddyModel: string;
  fallbackOnQuota: boolean;
  workspaceDirectory: string;
}

export interface PermissionRequestInfo {
  provider: AgentProvider;
  action: string;
  description: string;
}

export type AgentEventType =
  | 'status'
  | 'provider'
  | 'delta'
  | 'replace'
  | 'permission-request'
  | 'done'
  | 'error'
  | 'stopped';

export interface AgentEvent {
  sessionId: string;
  runId: string;
  type: AgentEventType;
  messageId?: string;
  delta?: string;
  content?: string;
  provider?: AgentProvider;
  model?: string;
  message?: string;
  approvalId?: string;
  action?: string;
  description?: string;
}

export interface DesktopAgentApi {
  listSessions(): Promise<ChatSession[]>;
  getSession(sessionId: string): Promise<ChatSession | null>;
  createSession(): Promise<ChatSession>;
  deleteSession(sessionId: string): Promise<void>;
  getSettings(): Promise<AgentSettings>;
  updateSettings(patch: Partial<AgentSettings>): Promise<AgentSettings>;
  pickWorkspace(): Promise<string | null>;
  sendMessage(sessionId: string, content: string): Promise<string>;
  stop(runId: string): Promise<boolean>;
  respondToPermission(approvalId: string, allowed: boolean): Promise<boolean>;
  onAgentEvent(handler: (event: AgentEvent) => void): () => void;
}

export const IPC = {
  listSessions: 'session:list',
  getSession: 'session:get',
  createSession: 'session:create',
  deleteSession: 'session:delete',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  pickWorkspace: 'workspace:pick',
  sendMessage: 'agent:send',
  stop: 'agent:stop',
  permissionResponse: 'agent:permission-response',
  event: 'agent:event',
} as const;

export function providerLabel(provider: AgentProvider): string {
  return provider === 'copilot' ? 'GitHub Copilot' : 'CodeBuddy';
}

export function providerShortLabel(provider: AgentProvider): string {
  return provider === 'copilot' ? 'Copilot' : 'CodeBuddy';
}
