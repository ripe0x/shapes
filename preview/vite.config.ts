import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 5173 is the preferred port; strictPort: false lets Vite fall through to the next free
  // port when it is already taken (a second harness, a stale server) rather than failing.
  server: { port: 5173, host: true, strictPort: false },
  build: {
    target: "es2022",
    // Two entries: the render harness (index.html) and the chain tester (chain.html).
    rollupOptions: { input: { main: "index.html", chain: "chain.html" } },
  },
  esbuild: { target: "es2022" },
});
