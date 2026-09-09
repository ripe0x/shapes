import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Selects the denomination ladder at build time, pairing with the foundry profile of the same
  // name. Unset means mainnet; see src/canonical/denominations.ts.
  define: {
    "process.env.SHAPES_LADDER": JSON.stringify(process.env.SHAPES_LADDER ?? ""),
    // Read directly in AuctionView.tsx; Next.js inlines NEXT_PUBLIC_ vars on its own, so this
    // entry only covers the site.html build below.
    "process.env.NEXT_PUBLIC_AUCTION_START_HIDDEN": JSON.stringify(
      process.env.NEXT_PUBLIC_AUCTION_START_HIDDEN ?? "",
    ),
  },
  // 5173 is the preferred port; strictPort: false lets Vite fall through to the next free
  // port when it is already taken (a second harness, a stale server) rather than failing.
  server: { port: 5173, host: true, strictPort: false },
  build: {
    target: "es2022",
    // Three entries: the render harness (index.html), the chain tester (chain.html) and the
    // public site (site.html).
    rollupOptions: { input: { main: "index.html", chain: "chain.html", site: "site.html" } },
  },
  esbuild: { target: "es2022" },
});
