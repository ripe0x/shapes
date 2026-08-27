Next.js site for Shapes.

It imports all UI and chain logic from `../preview/src` via the `@shared` alias (see
`next.config.ts`), so the site cannot drift from the parity-tested canonical renderer.

Chain target comes from `web/public/deployment.json`, with env overrides `SHAPES_RPC_URL`,
`SHAPES_CHAIN_ID`, and `SHAPES_ADDRESS` for the server-side deployment target (see
`app/lib/deployment.ts`).

For Sepolia, reads use the configured RPC first and then PublicNode, 1RPC, and Tenderly's public
endpoint. Set `SHAPES_RPC_URL` for the server-side OG route and `NEXT_PUBLIC_SHAPES_RPC_URL` for
browser reads when a paid/provider RPC is available. Requests are unbatched because shared site
reads already use Multicall3 and local seed demos can exceed Anvil's batch-size limit.

The wallet config is RainbowKit's `getDefaultConfig` (see `preview/src/chain/wagmi.ts`), built with
`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` and exactly one chain: the deployment's chain. On Sepolia this
is chain 11155111, so every wallet's connection proposal names Sepolia and its approval screen shows
Sepolia. `getDefaultConfig` provides the standard wallet inventory (Rainbow, MetaMask, Coinbase,
WalletConnect, Safe, ...). Without a project id (local dev), the config falls back to injected wallets
only, so no relay identity is created. Release evidence still requires a real phone pairing and
Sepolia mint.

Deployed via Netlify git auto-deploy from `main` (`../netlify.toml`).

## Development

Run `npm install` at the repo root (this is an npm workspace), then from `web/`:

```bash
portless
# or, on the plain port
npm run dev
```

Open [https://shapes.localhost](https://shapes.localhost), or use
[http://localhost:3000](http://localhost:3000) when running the plain Next dev server.
