import type { AgentProvider } from '../../shared/contracts.js';
import { isInsideWorkspace } from './workspace.js';

export function providerCandidates(preferredProvider: AgentProvider, fallbackOnQuota: boolean): AgentProvider[] {
  return preferredProvider === 'copilot' && fallbackOnQuota ? ['copilot', 'codebuddy'] : [preferredProvider];
}

/** Only one explicit file read inside the canonical workspace is implicitly allowed. */
export async function isImplicitWorkspaceRead(toolName: string, toolInput: unknown, workspace: string): Promise<boolean> {
  if (toolName !== 'Read' || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return false;
  const input = toolInput as Record<string, unknown>;
  const candidate = typeof input.file_path === 'string' ? input.file_path : input.path;
  return typeof candidate === 'string' && await isInsideWorkspace(workspace, candidate);
}

export function canFallbackAfterSideEffect(sideEffectApproved: boolean): boolean { return !sideEffectApproved; }

export function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bquota\b|rate[-\s]?limit|resource\s+exhausted|usage.?limit|limit\s+exceeded|too many requests|premium.{0,40}(request|usage).{0,30}(limit|exhausted)|HTTP\s*429|\b429\b/i.test(message);
}

export function isAbortError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\babort(?:ed)?\b|\binterrupt(?:ed)?\b|\bcancel(?:led|ed)?\b/i.test(message);
}

export function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) return '执行失败，请检查运行时配置后重试。';
  if (/not found|enoent/i.test(value) && /copilot|codebuddy|cli|command/i.test(value)) return '未找到所需的本地 Agent 运行环境。请确认 Copilot 或 CodeBuddy CLI 已安装并完成登录。';
  if (/auth|unauthori[sz]ed|forbidden|not logged in|login required/i.test(value)) return '当前 Agent 尚未完成认证，或账号没有访问权限。请先在对应 CLI 中登录，再重试。';
  if (isQuotaError(value)) return '当前模型的可用额度或请求频率已达到限制。可以切换运行时、稍后重试，或检查账号额度。';
  if (/network|ECONN|timed out|timeout/i.test(value)) return '连接 Agent 服务时遇到网络或超时问题，请稍后重试。';
  return value.length > 600 ? value.slice(0, 600) + '…' : value;
}
