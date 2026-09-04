Next.js site for Shapes.

It imports all UI and chain logic from `../preview/src` via the `@shared` alias (see
`next.config.ts`), so the site cannot drift from the parity-tested canonical renderer.

Chain target comes from `web/public/deployment.json`, with env overrides `SHAPES_RPC_URL`,
`SHAPES_CHAIN_ID`, and `SHAPES_ADDRESS` for the server-side deployment target (see
`app/lib/deployment.ts`).

`SHAPES_DEPLOYMENT_FILE` names a deployment record anywhere on disk and points the whole site at
it: the browser receives it as a prop from the root layout (`ShapesProviders`) instead of fetching
`/deployment.local.json`, the server routes read it through `serverDeployment()`, and
`next.config.ts` picks the denomination ladder from its chain id. It wins over both
`public/deployment.local.json` and the bundled `public/deployment.json`, so a run can target a
chain without writing either file. This is how `npm run e2e:browser` points the site at the chain
it deploys.

### Per-site deployment record

Two Netlify sites build this same `web/` from `main`: a Sepolia app and the mainnet launch app.
Both read a bundled `public/<name>.json` record, selected at build time by
`NEXT_PUBLIC_SHAPES_DEPLOYMENT` (default `deployment`, i.e. `public/deployment.json`, the mainnet
record). The Sepolia site sets `NEXT_PUBLIC_SHAPES_DEPLOYMENT=deployment.sepolia` to read
`public/deployment.sepolia.json` instead, so writing the mainnet record into `deployment.json`
during cutover cannot also flip the Sepolia site. `next.config.ts` fails the build if the selected
record's chain id does not match `SHAPES_LADDER`. Netlify env per site:

- Sepolia app: `NEXT_PUBLIC_SHAPES_DEPLOYMENT=deployment.sepolia`, `SHAPES_LADDER=testnet`,
  `SHAPES_SITE_MODE=app`.
- Mainnet launch app: `NEXT_PUBLIC_SHAPES_DEPLOYMENT` unset (or `deployment`),
  `SHAPES_LADDER` unset (mainnet default), `SHAPES_SITE_MODE=app`.

For Sepolia, reads use the configured RPC first and then PublicNode, 1RPC, and Tenderly's public
endpoint. Set `SHAPES_RPC_URL` for the server-side OG route and `NEXT_PUBLIC_SHAPES_RPC_URL` for
browser reads when a paid/provider RPC is available. Requests are unbatched because shared site
reads already use Multicall3 and local seed demos can exceed Anvil's batch-size limit.

### Indexer proxy

The browser never queries the Ponder indexer directly. Every indexer read goes to `/api/indexer`
on the site's own origin (`app/api/indexer/route.ts`), which forwards the GraphQL query to the
upstream server and returns its JSON. `ShapesProviders` sets `dep.indexerUrl` to that path, so the
upstream origin is not part of any client bundle or fetched record.

- `SHAPES_INDEXER_URL` — the upstream Ponder GraphQL endpoint, including `/graphql`
  (`https://shapes-indexer-mainnet.fly.dev/graphql`). Server-only, never `NEXT_PUBLIC_`.
- `SHAPES_INDEXER_TOKEN` — the bearer token the proxy presents, matching the indexer's
  `INDEXER_TOKEN` secret. Optional while the indexer is open.

With `SHAPES_INDEXER_URL` unset the proxy falls back to `indexerUrl` in the deployment record it
resolves (`SHAPES_DEPLOYMENT_FILE`, then `public/deployment.local.json`, then the bundled record),
so a local anvil run reaches its local indexer with no env var. `public/deployment.json`, the
mainnet record, carries no `indexerUrl`: a production deploy must name the upstream through
`SHAPES_INDEXER_URL`, and without it `/api/indexer` answers 503 and the site falls back to its
raw-RPC loader. `deployments/1.json` keeps `indexerUrl` for `indexer/deploy.sh` and the deploy
scripts.

GET requests to the proxy carry `Cache-Control: public, s-maxage=10, stale-while-revalidate=30`,
so the CDN absorbs the site's polling; POST is `no-store`.

The wallet config uses RainbowKit's standard `getDefaultConfig` (see
`preview/src/chain/wagmi.ts`), built with `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` and the deployment
chain. `getDefaultConfig` provides the maintained wallet inventory; each wallet decides which chains
it supports. Rainbow does not support testnets and is not used for Sepolia acceptance. Without a
project id (local dev), the config falls back to injected wallets only, so no relay identity is
created.

## Contracts page

`/contracts` lists every deployed contract and linked library with its address, and every function,
event and error with the NatSpec the Solidity carries. It is generated from the Foundry artifacts
in `out/` by `preview/scripts/genContractDocs.ts` into
`preview/src/chain/contractDocs.generated.ts`, which is committed, so the site build needs no
forge. After any ABI or NatSpec change run `forge build` and then `npm run contracts:docs` from
`preview/`, and commit the regenerated file; `npm run contracts:docs:check` fails on drift and runs
in CI. Library addresses come from the deployment record's `libraries` key; a library with no
recorded address shows as not recorded. The page reads nothing until a Call button is pressed.

Deployed as two isolated Netlify projects (`../netlify.toml`):

- Mainnet application: `shapes.ripe.wtf`, branch `main`, `SHAPES_SITE_MODE=app`. Builds the
  default `public/deployment.json` record against the mainnet ladder, so the mint panel, gallery,
  auction, and manage routes are all live at their normal paths.
- Sepolia application: `shapes-sepolia.netlify.app`, branch `main`, `SHAPES_SITE_MODE=app`,
  `SHAPES_LADDER=testnet`, `NEXT_PUBLIC_SHAPES_DEPLOYMENT=deployment.sepolia`.

The `launch` branch and `landing` mode carried the pre-mainnet countdown site and are retired from
production; `landing` still exists as a build mode. Netlify builds use `npm run build:netlify`,
which refuses an unsafe mode. `SHAPES_SITE_MODE`
defaults to `app` when unset, including local development, so the app home with the full mint
panel is at `/`. The root Netlify configuration explicitly includes `preview/` in its change
detection because the playground and canonical renderer are shared from that workspace.

## Development

Run `npm install` at the repo root (this is an npm workspace), then from `web/`:

```bash
portless
# or, on the plain port
npm run dev
```

Open [https://shapes.localhost](https://shapes.localhost), or use
[http://localhost:3000](http://localhost:3000) when running the plain Next dev server.

## Browser end-to-end run

```bash
npm run e2e:browser        # from the repo root
```

`web/e2e/run.sh` builds the contracts, starts anvil on port 8590, deploys with
`script/deploy.sh anvil`, copies the resulting `deployments/31337.json` into a temporary directory,
builds and serves the site against that copy through `SHAPES_DEPLOYMENT_FILE`, and runs
`web/e2e/browserFlow.mjs` in Chromium. It stops the chain and the server on exit and refuses to
start when either port is already in use. `E2E_CHAIN_PORT`, `E2E_SITE_PORT` and `E2E_OUT_DIR`
override the port pair and the screenshot directory (`web/e2e/out` by default, one image per step).

The walkthrough connects a wallet, mints five 0.01 ETH Shapes, filters the gallery to them,
composes them into one 0.05 ETH survivor, decomposes it, splits a 0.05 ETH Shape into five, redeems
one, and reads `symbol` from the contracts page, checking the chain after every step. Every step is
recorded and the run continues after a failure, so one broken step does not hide the ones after it.

`web/e2e/wallet.mjs` installs the wallet: `page.addInitScript` defines an EIP-1193 provider as
`window.ethereum` and announces it over EIP-6963, and every request is relayed to Node over one
Playwright binding, where a viem wallet client on anvil's account 1 answers the account, chain and
signing methods and forwards the rest to the RPC. Signing stays in Node so the page needs no
bundled wallet code. The wallet starts locked, so the run goes through the site's own connect
control instead of being reconnected on load.

Playwright is already a devDependency of `preview/`; a fresh checkout needs
`npx playwright install chromium` once.
