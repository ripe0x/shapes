import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
  build: {
    target: "es2022",
    // Two entries: the render harness (index.html) and the chain tester (chain.html).
    rollupOptions: { input: { main: "index.html", chain: "chain.html" } },
  },
  esbuild: { target: "es2022" },
});
