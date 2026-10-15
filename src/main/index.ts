import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent, type WebContents } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  AgentProvider,
  AgentSettings,
  ChatMessage,
  ChatSession,
  PermissionRequestInfo,
} from '../shared/contracts.js';
import { IPC, providerLabel } from '../shared/contracts.js';
import { executeWithFallback } from './agent/runtime.js';
import { friendlyError, isAbortError } from './agent/policy.js';
import { stopCopilotClient } from './agent/copilot.js';
import { createMessage, SessionStore, SettingsStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(app.getPath('userData'), 'desktop-agent');
const sessionStore = new SessionStore(dataDirectory);
const settingsStore = new SettingsStore(dataDirectory);

let mainWindow: BrowserWindow | null = null;
let settings: AgentSettings;
let activeRun: ActiveRun | null = null;

interface ActiveRun {
  runId: string;
  sessionId: string;
  messageId: string;
  stopRequested: boolean;
  abort?: () => Promise<void>;
}

interface PendingApproval {
  runId: string;
  resolve: (allowed: boolean) => void;
  timeout: NodeJS.Timeout;
}

const pendingApprovals = new Map<string, PendingApproval>();

function defaultSettings(): AgentSettings {
  return {
    preferredProvider: 'copilot',
    copilotModel: process.env.COPILOT_MODEL?.trim() || 'claude-sonnet-5.5',
    codebuddyModel: process.env.CODEBUDDY_MODEL?.trim() || 'glm-5.3-flash',
    fallbackOnQuota: true,
    workspaceDirectory: path.join(app.getPath('documents'), 'Desktop Agent Workspace'),
  };
}

function trusted(event: IpcMainEvent | Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('拒绝来自非应用窗口的请求。');
  }
}

function emit(event: AgentEvent): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(IPC.event, event);
}

function setRunAbort(run: ActiveRun, abort: () => Promise<void>): void {
  run.abort = abort;
  if (run.stopRequested) {
    void abort().catch((error) => {
      console.warn('[agent] Abort requested during provider startup, but provider cleanup failed.', error);
    });
  }
}

function permissionRequest(
  run: ActiveRun,
  request: PermissionRequestInfo,
): Promise<boolean> {
  if (run.stopRequested || !mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  const approvalId = randomUUID();

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      pendingApprovals.delete(approvalId);
      resolve(false);
      emit({
        sessionId: run.sessionId,
        runId: run.runId,
        messageId: run.messageId,
        type: 'status',
        message: '权限请求超时，已拒绝本次操作。',
      });
    }, 3 * 60 * 1000);

    pendingApprovals.set(approvalId, { runId: run.runId, resolve, timeout });
    emit({
      sessionId: run.sessionId,
      runId: run.runId,
      messageId: run.messageId,
      type: 'permission-request',
      approvalId,
      provider: request.provider,
      action: request.action,
      description: request.description,
      message: 'Agent 请求执行一项需要确认的操作。',
    });
  });
}

function resolveApprovalsForRun(runId: string, allowed: boolean): void {
  for (const [approvalId, pending] of pendingApprovals) {
    if (pending.runId !== runId) continue;
    clearTimeout(pending.timeout);
    pendingApprovals.delete(approvalId);
    pending.resolve(allowed);
  }
}

function buildPrompt(session: ChatSession, workingDirectory: string): string {
  const history = session.messages
    .filter((item) => item.status !== 'streaming' || item.role === 'user')
    .slice(-24)
    .map((item) => {
      const role = item.role === 'user' ? '用户' : '助手';
      const content = item.content.slice(-5000);
      return role + '：\n' + content;
    })
    .join('\n\n');

  return [
    '你是 Desktop Agent，一个面向本地工作区的通用 Agent。请用用户当前使用的语言回答。',
    '当前工作目录：' + workingDirectory,
    '执行原则：先检查实际上下文，再执行任务；涉及代码修改时，直接完成必要修改并尽可能验证；不要虚构已经执行过的操作或测试结果。',
    '权限边界：宿主会在文件修改、终端命令、网络访问等操作执行前请求用户确认。若用户拒绝，请尊重决定，不要以另一种工具重复同一操作。',
    '下面是最近对话历史，按顺序用于理解上下文。最末一条用户消息是当前需要处理的请求。',
    history,
  ].join('\n\n');
}

async function runTurn(
  run: ActiveRun,
  session: ChatSession,
  assistantMessage: ChatMessage,
  runSettings: AgentSettings,
): Promise<void> {
  try {
    const workingDirectory = runSettings.workspaceDirectory;
    await fs.mkdir(workingDirectory, { recursive: true });
    const prompt = buildPrompt(session, workingDirectory);

    const result = await executeWithFallback({
      preferredProvider: runSettings.preferredProvider,
      fallbackOnQuota: runSettings.fallbackOnQuota,
      models: {
        copilot: runSettings.copilotModel,
        codebuddy: runSettings.codebuddyModel,
      },
      prompt,
      workingDirectory,
      onProvider: (provider: AgentProvider, model: string) => {
        assistantMessage.provider = provider;
        assistantMessage.model = model;
        void sessionStore.save(session).catch((error) => {
          console.error('[storage] Could not persist the current provider selection.', error);
        });
        emit({
          sessionId: run.sessionId,
          runId: run.runId,
          messageId: run.messageId,
          type: 'provider',
          provider,
          model,
        });
      },
      onStatus: (status) => {
        emit({
          sessionId: run.sessionId,
          runId: run.runId,
          messageId: run.messageId,
          type: 'status',
          provider: assistantMessage.provider,
          message: status,
        });
      },
      onDelta: (delta) => {
        if (run.stopRequested || !delta) return;
        assistantMessage.content += delta;
        session.updatedAt = new Date().toISOString();
        void sessionStore.save(session).catch((error) => {
          console.error('[storage] Could not persist an assistant message delta.', error);
        });
        emit({
          sessionId: run.sessionId,
          runId: run.runId,
          messageId: run.messageId,
          type: 'delta',
          provider: assistantMessage.provider,
          delta,
        });
      },
      onFallback: async (from, to) => {
        assistantMessage.content = '';
        assistantMessage.provider = to;
        assistantMessage.model = to === 'copilot' ? runSettings.copilotModel : runSettings.codebuddyModel;
        await sessionStore.save(session);
        emit({
          sessionId: run.sessionId,
          runId: run.runId,
          messageId: run.messageId,
          type: 'replace',
          content: '',
          provider: to,
        });
        emit({
          sessionId: run.sessionId,
          runId: run.runId,
          messageId: run.messageId,
          type: 'status',
          provider: to,
          message: providerLabel(from) + ' 的可用额度已耗尽，正在切换到 ' + providerLabel(to) + '。',
        });
      },
      requestPermission: (request) => permissionRequest(run, request),
      setAbort: (abort) => setRunAbort(run, abort),
    });

    if (run.stopRequested) {
      assistantMessage.status = 'stopped';
      if (!assistantMessage.content.trim()) assistantMessage.content = '已停止本次执行。';
      await sessionStore.save(session);
      emit({
        sessionId: run.sessionId,
        runId: run.runId,
        messageId: run.messageId,
        type: 'stopped',
        content: assistantMessage.content,
      });
      return;
    }

    // Set the canonical SDK response as the final text; streamed deltas remain a
    // low-latency preview, while the stored message is always the provider's result.
    assistantMessage.content = result.content || assistantMessage.content;
    assistantMessage.provider = result.provider;
    assistantMessage.model = result.model;
    assistantMessage.status = 'complete';
    session.updatedAt = new Date().toISOString();
    await sessionStore.save(session);
    emit({
      sessionId: run.sessionId,
      runId: run.runId,
      messageId: run.messageId,
      type: 'done',
      content: assistantMessage.content,
      provider: result.provider,
      model: result.model,
    });
  } catch (error) {
    if (run.stopRequested || isAbortError(error)) {
      assistantMessage.status = 'stopped';
      if (!assistantMessage.content.trim()) assistantMessage.content = '已停止本次执行。';
      session.updatedAt = new Date().toISOString();
      await sessionStore.save(session);
      emit({
        sessionId: run.sessionId,
        runId: run.runId,
        messageId: run.messageId,
        type: 'stopped',
        content: assistantMessage.content,
      });
    } else {
      const message = friendlyError(error);
      assistantMessage.status = 'error';
      assistantMessage.content = assistantMessage.content.trim()
        ? assistantMessage.content + '\n\n执行未完成：' + message
        : message;
      session.updatedAt = new Date().toISOString();
      await sessionStore.save(session);
      emit({
        sessionId: run.sessionId,
        runId: run.runId,
        messageId: run.messageId,
        type: 'error',
        content: assistantMessage.content,
        message,
      });
      console.error('[agent] Turn execution failed.', {
        sessionId: run.sessionId,
        runId: run.runId,
        provider: assistantMessage.provider,
        error,
      });
    }
  } finally {
    resolveApprovalsForRun(run.runId, false);
    if (activeRun?.runId === run.runId) activeRun = null;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    title: 'Desktop Agent',
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // External navigation is intentionally not opened inside the privileged app window.
    console.warn('[security] Blocked an in-window navigation request.', url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  ipcMain.handle(IPC.listSessions, (event) => {
    trusted(event);
    return sessionStore.list();
  });

  ipcMain.handle(IPC.getSession, (event, sessionId: string) => {
    trusted(event);
    return sessionStore.get(sessionId);
  });

  ipcMain.handle(IPC.createSession, async (event) => {
    trusted(event);
    return sessionStore.create();
  });

  ipcMain.handle(IPC.deleteSession, async (event, sessionId: string) => {
    trusted(event);
    if (activeRun?.sessionId === sessionId) {
      throw new Error('当前对话正在执行任务，请先停止任务再删除。');
    }
    await sessionStore.delete(sessionId);
  });

  ipcMain.handle(IPC.getSettings, (event) => {
    trusted(event);
    return settings;
  });

  ipcMain.handle(IPC.updateSettings, async (event, patch: Partial<AgentSettings>) => {
    trusted(event);
    const next = { ...settings };
    if (patch.preferredProvider === 'copilot' || patch.preferredProvider === 'codebuddy') {
      next.preferredProvider = patch.preferredProvider;
    }
    if (typeof patch.copilotModel === 'string' && patch.copilotModel.trim()) {
      next.copilotModel = patch.copilotModel.trim().slice(0, 160);
    }
    if (typeof patch.codebuddyModel === 'string' && patch.codebuddyModel.trim()) {
      next.codebuddyModel = patch.codebuddyModel.trim().slice(0, 160);
    }
    if (typeof patch.fallbackOnQuota === 'boolean') next.fallbackOnQuota = patch.fallbackOnQuota;
    if (typeof patch.workspaceDirectory === 'string' && patch.workspaceDirectory.trim()) {
      next.workspaceDirectory = path.resolve(patch.workspaceDirectory.trim()).slice(0, 2000);
      await fs.mkdir(next.workspaceDirectory, { recursive: true });
    }
    settings = next;
    await settingsStore.save(settings);
    return settings;
  });

  ipcMain.handle(IPC.pickWorkspace, async (event) => {
    trusted(event);
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Agent 工作目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用此目录',
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.sendMessage, async (event, sessionId: string, content: string) => {
    trusted(event);
    const cleanContent = typeof content === 'string' ? content.trim() : '';
    if (!cleanContent) throw new Error('请先输入任务内容。');
    if (cleanContent.length > 30000) throw new Error('单条消息不能超过 30,000 个字符。');
    if (activeRun) throw new Error('当前已有任务在执行，请等待完成或先停止当前任务。');

    const session = sessionStore.get(sessionId);
    if (!session) throw new Error('没有找到这个对话，请重新选择或新建对话。');

    const userMessage = createMessage('user', cleanContent);
    const assistantMessage = createMessage('assistant', '', 'streaming');
    if (session.messages.length === 0) {
      session.title = cleanContent.replace(/\s+/g, ' ').slice(0, 42) || '新对话';
    }
    session.messages.push(userMessage, assistantMessage);
    session.updatedAt = new Date().toISOString();
    await sessionStore.save(session);

    const run: ActiveRun = {
      runId: randomUUID(),
      sessionId,
      messageId: assistantMessage.id,
      stopRequested: false,
    };
    activeRun = run;
    emit({
      sessionId,
      runId: run.runId,
      messageId: assistantMessage.id,
      type: 'status',
      message: '正在准备运行环境…',
      provider: settings.preferredProvider,
    });
    void runTurn(run, session, assistantMessage, { ...settings });
    return run.runId;
  });

  ipcMain.handle(IPC.stop, async (event, runId: string) => {
    trusted(event);
    if (!activeRun || activeRun.runId !== runId) return false;
    activeRun.stopRequested = true;
    resolveApprovalsForRun(runId, false);
    if (activeRun.abort) {
      await activeRun.abort().catch((error) => {
        console.warn('[agent] Provider stop request failed.', error);
      });
    }
    return true;
  });

  ipcMain.handle(IPC.permissionResponse, (event, approvalId: string, allowed: boolean) => {
    trusted(event);
    const pending = pendingApprovals.get(approvalId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    pendingApprovals.delete(approvalId);
    pending.resolve(Boolean(allowed));
    return true;
  });
}

app.whenReady().then(async () => {
  const defaults = defaultSettings();
  await sessionStore.initialize();
  settings = await settingsStore.load(defaults);
  await fs.mkdir(settings.workspaceDirectory, { recursive: true });
  await fs.mkdir(dataDirectory, { recursive: true });
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error('[startup] Desktop Agent could not start.', error);
  app.quit();
});

app.on('before-quit', () => {
  if (activeRun) {
    activeRun.stopRequested = true;
    resolveApprovalsForRun(activeRun.runId, false);
    if (activeRun.abort) void activeRun.abort().catch(() => undefined);
  }
  for (const pending of pendingApprovals.values()) {
    clearTimeout(pending.timeout);
    pending.resolve(false);
  }
  pendingApprovals.clear();
  void stopCopilotClient().catch((error) => {
    console.warn('[shutdown] Copilot client did not stop cleanly.', error);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
