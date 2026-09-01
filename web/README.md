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

The wallet config uses RainbowKit's standard `getDefaultConfig` (see
`preview/src/chain/wagmi.ts`), built with `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` and the deployment
chain. `getDefaultConfig` provides the maintained wallet inventory; each wallet decides which chains
it supports. Rainbow does not support testnets and is not used for Sepolia acceptance. Without a
project id (local dev), the config falls back to injected wallets only, so no relay identity is
created.

Deployed as two isolated Netlify projects (`../netlify.toml`):

- Production launch page: `shapes.ripe.wtf`, branch `launch`, `SHAPES_SITE_MODE=landing`.
- Sepolia application: separate Netlify URL, branch `main`, `SHAPES_SITE_MODE=app` and
  `SHAPES_LADDER=testnet`.

Netlify builds use `npm run build:netlify`, which refuses a missing or unsafe mode. A domain-level
proxy also blocks every application route on `shapes.ripe.wtf`, even if its environment is later
misconfigured. Local development defaults to hybrid mode: the launch page at `/`, and the app at
`/mint`.

## Development

Run `npm install` at the repo root (this is an npm workspace), then from `web/`:

```bash
portless
# or, on the plain port
npm run dev
```

Open [https://shapes.localhost](https://shapes.localhost), or use
[http://localhost:3000](http://localhost:3000) when running the plain Next dev server.
