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

WalletConnect is disabled unless `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is a real project id from
the project's WalletConnect Cloud account. Without it, injected wallets (for example MetaMask)
remain available. The production and preview build contexts have the project-owned public id;
with it, RainbowKit's maintained standard list exposes named Rainbow, Base Account, MetaMask and
WalletConnect choices, plus Safe in its applicable context. Release evidence still requires a real
phone pairing and Sepolia mint.

WalletConnect requires the deployment chain in its session namespace. A versioned storage prefix
prevents a stale session from an older chain policy being silently reused. Sepolia deployments
therefore connect on Sepolia directly; Shapes never uses mainnet as a connection bootstrap.

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
