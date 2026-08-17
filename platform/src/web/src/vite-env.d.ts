/// <reference types="vite/client" />

import type { DesktopTerminalApi } from '../../shared/contracts';

declare global {
  interface Window {
    techunterDesktop?: DesktopTerminalApi;
  }
}

export {};
