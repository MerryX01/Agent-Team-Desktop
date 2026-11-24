/// <reference types="vite/client" />

declare global {
  interface Window {
    desktopApi?: import('../electron/preload/index').DesktopApi
  }
}

export {}
