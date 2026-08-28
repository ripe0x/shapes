interface ImportMetaEnv {
  readonly VITE_SHAPES_RPC_URL?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
