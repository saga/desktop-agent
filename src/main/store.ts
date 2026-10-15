import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSettings, ChatMessage, ChatSession, MessageStatus } from '../shared/contracts.js';

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + '.tmp';
  await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

function copySession(session: ChatSession): ChatSession {
  return JSON.parse(JSON.stringify(session)) as ChatSession;
}

export class SessionStore {
  private readonly filePath: string;
  private readonly sessions = new Map<string, ChatSession>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.filePath = path.join(dataDirectory, 'sessions.json');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as ChatSession[];
      for (const session of parsed) {
        if (!session || typeof session.id !== 'string' || !Array.isArray(session.messages)) continue;
        for (const message of session.messages) {
          if (message.status === 'streaming') message.status = 'stopped';
        }
        this.sessions.set(session.id, session);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      console.error('[storage] Conversation history could not be read; preserving a backup.', error);
      try {
        await fs.rename(this.filePath, this.filePath + '.corrupt-' + Date.now());
      } catch (backupError) {
        console.error('[storage] Could not back up the unreadable history file.', backupError);
      }
    }
  }

  list(): ChatSession[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(copySession);
  }

  get(sessionId: string): ChatSession | null {
    const session = this.sessions.get(sessionId);
    return session ? copySession(session) : null;
  }

  async create(): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: randomUUID(),
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.set(session.id, session);
    await this.persist();
    return copySession(session);
  }

  async save(session: ChatSession): Promise<void> {
    this.sessions.set(session.id, session);
    await this.persist();
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.persist();
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const snapshot = JSON.stringify([...this.sessions.values()]);
      await atomicWrite(this.filePath, snapshot);
    });
    return this.writeChain;
  }
}

export class SettingsStore {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.filePath = path.join(dataDirectory, 'settings.json');
  }

  async load(defaults: AgentSettings): Promise<AgentSettings> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<AgentSettings>;
      return {
        ...defaults,
        preferredProvider: raw.preferredProvider === 'codebuddy' ? 'codebuddy' : 'copilot',
        copilotModel: typeof raw.copilotModel === 'string' && raw.copilotModel.trim()
          ? raw.copilotModel.trim()
          : defaults.copilotModel,
        codebuddyModel: typeof raw.codebuddyModel === 'string' && raw.codebuddyModel.trim()
          ? raw.codebuddyModel.trim()
          : defaults.codebuddyModel,
        fallbackOnQuota: typeof raw.fallbackOnQuota === 'boolean'
          ? raw.fallbackOnQuota
          : defaults.fallbackOnQuota,
        workspaceDirectory: typeof raw.workspaceDirectory === 'string' && raw.workspaceDirectory.trim()
          ? raw.workspaceDirectory.trim()
          : defaults.workspaceDirectory,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[storage] Agent settings could not be read; using safe defaults.', error);
      }
      return defaults;
    }
  }

  async save(settings: AgentSettings): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await atomicWrite(this.filePath, JSON.stringify(settings, null, 2));
    });
    await this.writeChain;
  }
}

export function createMessage(role: ChatMessage['role'], content: string, status?: MessageStatus): ChatMessage {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(status ? { status } : {}),
  };
}
