import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAgentApi, AgentEvent, AgentSettings } from '../shared/contracts.js';
import { IPC } from '../shared/contracts.js';

const api: DesktopAgentApi = {
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  getSession: (sessionId) => ipcRenderer.invoke(IPC.getSession, sessionId),
  createSession: () => ipcRenderer.invoke(IPC.createSession),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.deleteSession, sessionId),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch: Partial<AgentSettings>) => ipcRenderer.invoke(IPC.updateSettings, patch),
  pickWorkspace: () => ipcRenderer.invoke(IPC.pickWorkspace),
  sendMessage: (sessionId, content) => ipcRenderer.invoke(IPC.sendMessage, sessionId, content),
  stop: (runId) => ipcRenderer.invoke(IPC.stop, runId),
  respondToPermission: (approvalId, allowed) => ipcRenderer.invoke(IPC.permissionResponse, approvalId, allowed),
  onAgentEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => handler(payload);
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
};

contextBridge.exposeInMainWorld('desktopAgent', api);
