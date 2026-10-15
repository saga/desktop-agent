import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Drawer,
  Input,
  Modal,
  Select,
  Switch,
  Tag,
  Tooltip,
} from 'antd';
import {
  AppstoreOutlined,
  ArrowUpOutlined,
  CodeOutlined,
  FolderOpenOutlined,
  GithubOutlined,
  MessageOutlined,
  PlusOutlined,
  ReadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Bubble, Sender } from '@ant-design/x';
import { XMarkdown } from '@ant-design/x-markdown';
import type {
  AgentEvent,
  AgentProvider,
  AgentSettings,
  ChatMessage,
  ChatSession,
  PermissionRequestInfo,
} from '@shared/contracts.js';
import { providerLabel, providerShortLabel } from '@shared/contracts.js';

interface PendingApproval extends PermissionRequestInfo {
  approvalId: string;
}

const INITIAL_SETTINGS: AgentSettings = {
  preferredProvider: 'copilot',
  copilotModel: 'claude-sonnet-5.5',
  codebuddyModel: 'glm-5.3-flash',
  fallbackOnQuota: true,
  workspaceDirectory: '',
};

const bubbleRoles = {
  assistant: { placement: 'start' as const },
  user: { placement: 'end' as const },
};

const SUGGESTIONS = [
  {
    title: '理解一个代码库',
    description: '梳理项目结构、关键模块和执行入口',
    prompt: '请先检查当前工作区的项目结构，梳理关键模块、主要执行入口和重要依赖，再给我一份有优先级的说明。',
    icon: <CodeOutlined />,
  },
  {
    title: '分析并解决问题',
    description: '定位原因、实施修改并验证结果',
    prompt: '请检查当前工作区，找出影响最大的错误或风险。先说明准备怎么处理，再直接完成必要修复并运行相关验证。',
    icon: <ThunderboltOutlined />,
  },
  {
    title: '审查架构设计',
    description: '关注边界、扩展性和维护成本',
    prompt: '请从资深软件架构师的角度审查当前工作区，重点检查模块边界、依赖方向、可扩展性、可维护性和可观测性，给出有证据的优先改进项。',
    icon: <ReadOutlined />,
  },
];

function providerColor(provider: AgentProvider | undefined): string {
  return provider === 'codebuddy' ? 'cyan' : 'purple';
}

function initialMessageStatus(message: ChatMessage): string {
  if (message.status === 'error') return '未完成';
  if (message.status === 'stopped') return '已停止';
  if (message.status === 'streaming') return '执行中';
  return '';
}

export default function App() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<AgentSettings>(INITIAL_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<AgentSettings>(INITIAL_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [activity, setActivity] = useState('');
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runningProvider, setRunningProvider] = useState<AgentProvider | undefined>();
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [startupError, setStartupError] = useState('');
  const selectedSessionIdRef = useRef('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  selectedSessionIdRef.current = activeSessionId;

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const currentProvider = runningProvider ?? settings.preferredProvider;
  const isRunning = runningSessionId === activeSessionId && Boolean(activeSessionId);
  const anyRunActive = Boolean(runningSessionId);

  const refreshSessions = useCallback(async () => {
    const next = await window.desktopAgent.listSessions();
    setSessions(next);
    return next;
  }, []);

  const openSession = useCallback(async (sessionId: string) => {
    const session = await window.desktopAgent.getSession(sessionId);
    if (!session) return;
    setActiveSessionId(session.id);
    setMessages(session.messages);
    setDraft('');
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.desktopAgent.onAgentEvent((event: AgentEvent) => {
      const isVisible = selectedSessionIdRef.current === event.sessionId;

      if (event.type === 'permission-request' && event.approvalId && event.provider) {
        setPendingApproval({
          approvalId: event.approvalId,
          provider: event.provider,
          action: event.action ?? '工具操作',
          description: event.description ?? 'Agent 请求执行一项操作。',
        });
      }

      if (isVisible) {
        if (event.type === 'status') {
          setActivity(event.message ?? '助手正在处理…');
        } else if (event.type === 'provider' && event.provider) {
          setRunningProvider(event.provider);
        } else if (event.type === 'delta' && event.messageId) {
          setMessages((current) => current.map((item) => item.id === event.messageId
            ? {
                ...item,
                content: item.content + (event.delta ?? ''),
                provider: event.provider ?? item.provider,
                status: 'streaming',
              }
            : item));
        } else if (event.type === 'replace' && event.messageId) {
          setMessages((current) => current.map((item) => item.id === event.messageId
            ? {
                ...item,
                content: event.content ?? '',
                provider: event.provider ?? item.provider,
                status: 'streaming',
              }
            : item));
        } else if (event.type === 'done' && event.messageId) {
          setMessages((current) => current.map((item) => item.id === event.messageId
            ? {
                ...item,
                content: event.content ?? item.content,
                provider: event.provider ?? item.provider,
                model: event.model ?? item.model,
                status: 'complete',
              }
            : item));
          setActivity('');
          setRunningProvider(undefined);
        } else if (event.type === 'error' && event.messageId) {
          setMessages((current) => current.map((item) => item.id === event.messageId
            ? { ...item, content: event.content ?? event.message ?? item.content, status: 'error' }
            : item));
          setActivity('');
          setRunningProvider(undefined);
        } else if (event.type === 'stopped' && event.messageId) {
          setMessages((current) => current.map((item) => item.id === event.messageId
            ? { ...item, content: event.content ?? item.content, status: 'stopped' }
            : item));
          setActivity('');
          setRunningProvider(undefined);
        }
      }

      if (event.type === 'done' || event.type === 'error' || event.type === 'stopped') {
        setRunningSessionId((current) => current === event.sessionId ? null : current);
        setActiveRunId((current) => current === event.runId ? null : current);
        void refreshSessions();
        if (isVisible) {
          void window.desktopAgent.getSession(event.sessionId).then((session) => {
            if (session && selectedSessionIdRef.current === event.sessionId) {
              setMessages(session.messages);
            }
          });
        }
      }
    });

    void (async () => {
      try {
        const [nextSessions, nextSettings] = await Promise.all([
          window.desktopAgent.listSessions(),
          window.desktopAgent.getSettings(),
        ]);
        if (cancelled) return;
        setSettings(nextSettings);
        setSettingsDraft(nextSettings);
        if (nextSessions.length > 0) {
          setSessions(nextSessions);
          setActiveSessionId(nextSessions[0].id);
          setMessages(nextSessions[0].messages);
        } else {
          const created = await window.desktopAgent.createSession();
          if (cancelled) return;
          setSessions([created]);
          setActiveSessionId(created.id);
          setMessages([]);
        }
      } catch (error) {
        if (!cancelled) {
          setStartupError(error instanceof Error ? error.message : '无法初始化本地工作区。');
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refreshSessions]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, activity]);

  const bubbleItems = useMemo(() => messages.map((item) => ({
    key: item.id,
    role: item.role,
    content: (
      <div className="bubble-message">
        {item.content ? (
          item.role === 'assistant'
            ? <div className="bubble-text"><XMarkdown content={item.content} /></div>
            : <div className="bubble-text">{item.content}</div>
        ) : item.status === 'streaming' ? (
          <span className="thinking-copy"><span className="thinking-dots" /> 正在思考…</span>
        ) : null}
        {item.role === 'assistant' && (item.provider || item.status) ? (
          <div className="bubble-meta">
            {item.provider ? <span>{providerShortLabel(item.provider)}{item.model ? ' · ' + item.model : ''}</span> : null}
            {initialMessageStatus(item) ? <span>{initialMessageStatus(item)}</span> : null}
          </div>
        ) : null}
      </div>
    ),
  })), [messages]);

  const startNewSession = async () => {
    try {
      const created = await window.desktopAgent.createSession();
      const next = await refreshSessions();
      setSessions(next);
      setActiveSessionId(created.id);
      setMessages([]);
      setDraft('');
      setActivity('');
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : '新建对话失败。');
    }
  };

  const sendMessage = async (rawValue: string) => {
    const value = rawValue.trim();
    if (!value || !activeSessionId || anyRunActive) return;
    setDraft('');
    setRunningSessionId(activeSessionId);
    setRunningProvider(settings.preferredProvider);
    setActivity('正在准备运行环境…');
    setStartupError('');
    try {
      const runId = await window.desktopAgent.sendMessage(activeSessionId, value);
      setActiveRunId(runId);
      const session = await window.desktopAgent.getSession(activeSessionId);
      if (session && selectedSessionIdRef.current === activeSessionId) setMessages(session.messages);
      await refreshSessions();
    } catch (error) {
      setRunningSessionId(null);
      setRunningProvider(undefined);
      setActivity('');
      setStartupError(error instanceof Error ? error.message : '无法启动 Agent 任务。');
      const session = await window.desktopAgent.getSession(activeSessionId);
      if (session) setMessages(session.messages);
    }
  };

  const stopCurrentRun = async () => {
    if (!activeRunId) return;
    setActivity('正在停止当前任务…');
    try {
      await window.desktopAgent.stop(activeRunId);
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : '停止任务失败。');
    }
  };

  const updatePreferredProvider = async (provider: AgentProvider) => {
    try {
      const next = await window.desktopAgent.updateSettings({ preferredProvider: provider });
      setSettings(next);
      setSettingsDraft(next);
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : '更新运行时失败。');
    }
  };

  const showSettings = () => {
    setSettingsDraft(settings);
    setSettingsOpen(true);
  };

  const chooseWorkspace = async () => {
    const directory = await window.desktopAgent.pickWorkspace();
    if (directory) setSettingsDraft((current) => ({ ...current, workspaceDirectory: directory }));
  };

  const saveSettings = async () => {
    if (!settingsDraft.copilotModel.trim() || !settingsDraft.codebuddyModel.trim()) {
      setStartupError('请填写 Copilot 和 CodeBuddy 的模型名称。');
      return;
    }
    try {
      const next = await window.desktopAgent.updateSettings(settingsDraft);
      setSettings(next);
      setSettingsDraft(next);
      setSettingsOpen(false);
      setStartupError('');
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : '保存设置失败。');
    }
  };

  const respondToApproval = async (allowed: boolean) => {
    if (!pendingApproval) return;
    const current = pendingApproval;
    setPendingApproval(null);
    await window.desktopAgent.respondToPermission(current.approvalId, allowed);
  };

  return (
    <div className="desktop-app">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><RobotOutlined /></div>
          <div>
            <div className="brand-name">Desktop Agent</div>
            <div className="brand-caption">YOUR LOCAL AI WORKSPACE</div>
          </div>
        </div>

        <Button className="new-chat-button" block icon={<PlusOutlined />} onClick={() => void startNewSession()}>
          新建对话
        </Button>

        <div className="sidebar-group-title">
          <span>最近对话</span>
          <span className="session-count">{sessions.length}</span>
        </div>
        <nav className="session-nav" aria-label="最近对话">
          {sessions.map((session) => (
            <button
              type="button"
              className={'session-link' + (session.id === activeSessionId ? ' active' : '')}
              key={session.id}
              onClick={() => void openSession(session.id)}
              title={session.title}
            >
              <MessageOutlined />
              <span className="session-title">{session.title}</span>
              {runningSessionId === session.id ? <span className="running-indicator" /> : null}
            </button>
          ))}
          {sessions.length === 0 ? <div className="empty-sessions">还没有对话</div> : null}
        </nav>

        <div className="sidebar-bottom">
          <div className="workspace-card">
            <div className="workspace-card-icon"><FolderOpenOutlined /></div>
            <div className="workspace-card-copy">
              <span>当前工作目录</span>
              <strong title={settings.workspaceDirectory}>
                {settings.workspaceDirectory ? settings.workspaceDirectory.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : '尚未配置'}
              </strong>
            </div>
            <Tooltip title="选择工作目录">
              <Button
                type="text"
                size="small"
                icon={<SettingOutlined />}
                onClick={showSettings}
                aria-label="打开偏好设置"
              />
            </Tooltip>
          </div>
          <Button className="settings-link" block type="text" icon={<SettingOutlined />} onClick={showSettings}>
            偏好设置
          </Button>
          <div className="privacy-note"><SafetyCertificateOutlined /> 会话保存在本机</div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-heading">
            <div className="breadcrumb-line">
              <span className="breadcrumb-muted">工作台</span>
              <span className="breadcrumb-divider">/</span>
              <span className="breadcrumb-current">{activeSession?.title ?? '新对话'}</span>
            </div>
            <div className="topbar-subtitle">让 Agent 直接推进任务，而不止给出建议</div>
          </div>
          <div className="topbar-actions">
            <Tag className="local-tag" icon={<SafetyCertificateOutlined />}>本地运行</Tag>
            <Select
              className="provider-select"
              value={settings.preferredProvider}
              options={[
                { value: 'copilot', label: 'GitHub Copilot' },
                { value: 'codebuddy', label: 'CodeBuddy' },
              ]}
              onChange={(value: AgentProvider) => void updatePreferredProvider(value)}
              aria-label="首选 Agent 运行时"
            />
            {anyRunActive ? (
              <Button danger icon={<StopOutlined />} onClick={() => void stopCurrentRun()}>
                停止任务
              </Button>
            ) : null}
          </div>
        </header>

        <section className={'conversation-stage' + (messages.length === 0 ? ' conversation-empty' : '')}>
          {startupError ? (
            <Alert
              className="startup-alert"
              type="error"
              showIcon
              closable
              message={startupError}
              onClose={() => setStartupError('')}
            />
          ) : null}

          {messages.length === 0 ? (
            <div className="welcome-panel">
              <div className="welcome-badge"><span className="welcome-orbit" /><AppstoreOutlined /> LOCAL AGENT WORKSPACE</div>
              <h1>让想法，变成<br /><span>可交付的结果。</span></h1>
              <p className="welcome-description">
                描述你想完成的工作。Agent 会结合当前工作目录进行分析、调用工具、修改文件，并在执行关键操作前征求你的确认。
              </p>

              <div className="suggestion-grid">
                {SUGGESTIONS.map((suggestion, index) => (
                  <button
                    type="button"
                    className="suggestion-card"
                    key={suggestion.title}
                    onClick={() => setDraft(suggestion.prompt)}
                  >
                    <span className={'suggestion-icon suggestion-icon-' + index}>{suggestion.icon}</span>
                    <span className="suggestion-title">{suggestion.title}</span>
                    <span className="suggestion-description">{suggestion.description}</span>
                    <span className="suggestion-arrow">↗</span>
                  </button>
                ))}
              </div>

              <div className="runtime-summary">
                <span className="runtime-summary-icon"><GithubOutlined /></span>
                <span><strong>Copilot SDK</strong><small>配额耗尽时可自动切换到 CodeBuddy</small></span>
                <span className="summary-status"><span /> 已配置</span>
              </div>
            </div>
          ) : (
            <div className="message-column">
              <div className="conversation-intro">
                <div className="conversation-intro-icon"><MessageOutlined /></div>
                <div>
                  <div className="conversation-intro-title">{activeSession?.title ?? '对话'}</div>
                  <div className="conversation-intro-subtitle">对话记录自动保存在本机，可在下次启动时继续查看。</div>
                </div>
              </div>
              <Bubble.List className="message-list" items={bubbleItems} role={bubbleRoles} />
              <div ref={messagesEndRef} />
              {isRunning && activity ? (
                <div className="activity-line">
                  <span className="activity-pulse" />
                  <span>{activity}</span>
                  {runningProvider ? <Tag color={providerColor(runningProvider)}>{providerShortLabel(runningProvider)}</Tag> : null}
                </div>
              ) : null}
            </div>
          )}
        </section>

        <footer className="composer-footer">
          <div className="composer-shell">
            {messages.length === 0 ? (
              <div className="composer-context">
                <span><FolderOpenOutlined /> {settings.workspaceDirectory ? settings.workspaceDirectory : '请选择工作目录'}</span>
                <Button type="link" size="small" onClick={showSettings}>更改</Button>
              </div>
            ) : null}
            <div className="composer-row">
              <Sender
                value={draft}
                onChange={setDraft}
                onSubmit={(value) => { void sendMessage(value); }}
                placeholder={anyRunActive ? '任务执行中…可以先停止当前任务' : '告诉 Agent 你想完成什么…'}
                loading={isRunning}
                disabled={anyRunActive}
                className="agent-sender"
              />
              {anyRunActive ? (
                <Button
                  className="composer-stop"
                  icon={<StopOutlined />}
                  onClick={() => void stopCurrentRun()}
                  aria-label="停止当前任务"
                />
              ) : (
                <Button
                  type="primary"
                  className="composer-send"
                  icon={<ArrowUpOutlined />}
                  disabled={!draft.trim()}
                  onClick={() => void sendMessage(draft)}
                  aria-label="发送消息"
                />
              )}
            </div>
            <div className="composer-footnote">
              <span><SafetyCertificateOutlined /> 高风险操作会请求确认</span>
              <span>Enter 发送 · Shift + Enter 换行</span>
            </div>
          </div>
        </footer>
      </main>

      <Drawer
        title={<div className="settings-title"><SettingOutlined /> 偏好设置</div>}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        width={460}
        destroyOnClose={false}
        footer={
          <div className="drawer-footer">
            <Button onClick={() => setSettingsOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => void saveSettings()}>保存设置</Button>
          </div>
        }
      >
        <div className="settings-section">
          <div className="settings-section-heading">Agent 运行时</div>
          <p className="settings-help">设置首选模型运行环境。只有明确的额度或频率限制才会触发自动 fallback。</p>
          <label className="field-label">首选运行时</label>
          <Select
            size="large"
            block
            value={settingsDraft.preferredProvider}
            options={[
              { value: 'copilot', label: 'GitHub Copilot SDK' },
              { value: 'codebuddy', label: 'CodeBuddy Agent SDK' },
            ]}
            onChange={(value: AgentProvider) => setSettingsDraft((current) => ({ ...current, preferredProvider: value }))}
          />

          <div className="setting-field">
            <label className="field-label">Copilot 模型</label>
            <Input
              size="large"
              value={settingsDraft.copilotModel}
              onChange={(event) => setSettingsDraft((current) => ({ ...current, copilotModel: event.target.value }))}
              placeholder="例如 claude-sonnet-5.5"
            />
            <div className="field-hint">模型名称需要与当前 Copilot 账号的可用模型一致。</div>
          </div>

          <div className="setting-field">
            <label className="field-label">CodeBuddy 模型</label>
            <Input
              size="large"
              value={settingsDraft.codebuddyModel}
              onChange={(event) => setSettingsDraft((current) => ({ ...current, codebuddyModel: event.target.value }))}
              placeholder="例如 glm-5.3-flash"
            />
          </div>

          <div className="fallback-setting">
            <div>
              <strong>配额耗尽时自动切换</strong>
              <p>Copilot 明确返回额度或限流错误时，自动尝试 CodeBuddy。认证、工具和业务错误不会触发切换。</p>
            </div>
            <Switch
              checked={settingsDraft.fallbackOnQuota}
              onChange={(checked) => setSettingsDraft((current) => ({ ...current, fallbackOnQuota: checked }))}
            />
          </div>
        </div>

        <Divider />

        <div className="settings-section">
          <div className="settings-section-heading">工作目录</div>
          <p className="settings-help">Agent 会将所选文件夹作为项目上下文和工具执行目录。建议选择具体项目目录，而不是整个用户主目录。</p>
          <div className="workspace-picker">
            <Input.TextArea
              value={settingsDraft.workspaceDirectory}
              onChange={(event) => setSettingsDraft((current) => ({ ...current, workspaceDirectory: event.target.value }))}
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="选择一个本地项目目录"
            />
            <Button icon={<FolderOpenOutlined />} onClick={() => void chooseWorkspace()}>浏览…</Button>
          </div>
        </div>

        <Divider />

        <div className="settings-section local-storage-note">
          <div className="settings-section-heading"><SafetyCertificateOutlined /> 本地数据与权限</div>
          <p>会话历史与设置存储在本机。页面不直接访问 Node.js；文件修改、终端命令与网络访问等敏感操作会由主进程向你请求确认。</p>
        </div>
      </Drawer>

      <Modal
        title={<div className="approval-title"><SafetyCertificateOutlined /> 确认 Agent 操作</div>}
        open={Boolean(pendingApproval)}
        onCancel={() => void respondToApproval(false)}
        closable={false}
        maskClosable={false}
        footer={[
          <Button key="deny" onClick={() => void respondToApproval(false)}>拒绝</Button>,
          <Button key="allow" type="primary" onClick={() => void respondToApproval(true)}>允许本次操作</Button>,
        ]}
      >
        {pendingApproval ? (
          <div className="approval-content">
            <div className="approval-meta">
              <Tag color={providerColor(pendingApproval.provider)}>{providerLabel(pendingApproval.provider)}</Tag>
              <Tag>{pendingApproval.action}</Tag>
            </div>
            <p>Agent 需要执行以下操作才能继续。请先检查命令或目标路径，再决定是否允许。</p>
            <pre>{pendingApproval.description}</pre>
            <div className="approval-warning"><SafetyCertificateOutlined /> 仅本次操作会被授权，不会保存为永久许可。</div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
