/// <reference types="vite/client" />

import type { DesktopAgentApi } from '../../shared/desktop-contracts';

declare global {
  interface Window {
    techunterDesktop?: DesktopAgentApi;
  }
}

export {};
