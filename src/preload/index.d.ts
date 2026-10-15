import type { DesktopAgentApi } from '../shared/contracts.js';

declare global {
  interface Window {
    desktopAgent: DesktopAgentApi;
  }
}

export {};
