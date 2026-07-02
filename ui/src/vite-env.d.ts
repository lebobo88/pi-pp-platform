/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" enables the in-browser mock daemon (fixtures + scripted SSE). */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
