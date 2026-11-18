Next.js site for Shapes.

## Shape Packs

`/packs` is in the shared site navigation. The production site uses mainnet Shapes
`0x6fe9193276bf7abcbee44ab7afd717d637d6faf0`, ShapePacks
`0xf21514b090da7df4390803497d6ae673801e5ca7`, and renderer
`0x934c491dda49c8058347c3fca191852d54705645`. The separate Sepolia site and local
Sepolia preview use Shapes `0x6c2f9c00f44fbbf141dd166979903004b80d5f99`, ShapePacks
`0x6DB763fB3FA5B988BEDa8E7a4288c79d7E1E6f45`, renderer
`0xbFa47D2047D61AE8eAA685008e1272E4F9d6ea60`, and Tenderly's public Sepolia RPC.
The page verifies deployed bytecode and contract pointers before enabling actions, and reads
pack artwork through `tokenURI`.
The page reads the creation floor, denomination table, mint fee and exact mint quote from the
contracts. It lets a wallet create from owned Shapes, newly minted Shapes or both; add to a live
pack; merge other live packs owned by the wallet into a selected target; inspect contents and
backing; and open for Shapes or redeem for ETH. A merge burns the source pack tokens while the
target keeps its ID and receives their Shapes and backing, with no ETH payment. Large packs can be
unsealed and claimed in chunks. Contract fees and limits are read on the selected chain.

Read-only checks (no wallet signature or transaction):

```sh
node web/e2e/packsLiveReadOnly.mjs
PACKS_TEST_CHAIN=mainnet node web/e2e/packsLiveReadOnly.mjs
CANDIDATE_RUN=1 NEXT_PUBLIC_SHAPES_DEPLOYMENT=deployment.sepolia SHAPES_LADDER=testnet npm run build --workspace web
NEXT_PUBLIC_SHAPES_DEPLOYMENT=deployment.sepolia SHAPES_LADDER=testnet npm run start --workspace web -- --port 3191
E2E_BASE_URL=http://127.0.0.1:3191 node web/e2e/packsBrowserReadOnly.mjs
E2E_BASE_URL=http://127.0.0.1:3191 node web/e2e/packsMergeBrowserReadOnly.mjs
CANDIDATE_RUN=1 NEXT_PUBLIC_SITE_URL=https://shapes.ripe.wtf SHAPES_LADDER=mainnet npm run build --workspace web
NEXT_PUBLIC_SITE_URL=https://shapes.ripe.wtf SHAPES_LADDER=mainnet npm run start --workspace web -- --port 3192
PACKS_TEST_CHAIN=mainnet PACKS_TEST_ALLOW_LOCAL_INDEXER_401=1 E2E_BASE_URL=http://127.0.0.1:3192 node web/e2e/packsBrowserReadOnly.mjs
```

The browser check uses a wallet stub that rejects every signing and transaction request. Set
`PLAYWRIGHT_CHROME_PATH` to an installed Chrome executable if Playwright's browser is unavailable.
The merge browser fixture checks selection and wallet calldata without submitting a transaction.
The live Sepolia read check now also simulates a successful merge using packs owned by the test
account. For a local mainnet preview without the private indexer token, set
`PACKS_TEST_ALLOW_LOCAL_INDEXER_401=1`; the browser check then verifies the raw-RPC fallback.

It imports all UI and chain logic from `../preview/src` via the `@shared` alias (see
`next.config.ts`), so the site cannot drift from the parity-tested canonical renderer.

Chain target comes from `web/public/deployment.json`, with env overrides `SHAPES_RPC_URL`,
`SHAPES_CHAIN_ID`, and `SHAPES_ADDRESS` for the server-side deployment target (see
`app/lib/deployment.ts`).

`SHAPES_DEPLOYMENT_FILE` names a deployment record anywhere on disk and points the whole site at
it: the browser receives it as a prop from the root layout (`ShapesProviders`), the server routes
read it through `serverDeployment()`, and
`next.config.ts` picks the denomination ladder from its chain id. It wins over both
`public/deployment.local.json` and the bundled `public/deployment.json`, so a run can target a
chain without writing either file. This is how `npm run e2e:browser` points the site at the chain
it deploys.

### Per-site deployment record

Two Netlify sites build this same `web/` from `main`: a Sepolia app and the mainnet launch app.
Both use a bundled `public/<name>.json` record, selected at build time by
`NEXT_PUBLIC_SHAPES_DEPLOYMENT` (default `deployment`, i.e. `public/deployment.json`, the mainnet
record). The Sepolia site sets `NEXT_PUBLIC_SHAPES_DEPLOYMENT=deployment.sepolia` to read
`public/deployment.sepolia.json` instead, so writing the mainnet record into `deployment.json`
during cutover cannot also flip the Sepolia site. `next.config.ts` fails the build if the selected
record's chain id does not match `SHAPES_LADDER`. Netlify env per site:

- Sepolia app: `NEXT_PUBLIC_SHAPES_DEPLOYMENT=deployment.sepolia`, `SHAPES_LADDER=testnet`,
  `SHAPES_SITE_MODE=app`.
- Mainnet production app: `NEXT_PUBLIC_SHAPES_DEPLOYMENT` unset (or `deployment`),
  `SHAPES_LADDER=mainnet`, `SHAPES_SITE_MODE=app`,
  `NEXT_PUBLIC_SITE_URL=https://shapes.ripe.wtf`, and the existing indexer and wallet variables.
  The production hostname fails its build if the selected deployment is not mainnet. Packs needs
  no additional Netlify environment variable; its addresses are selected with the site's Shapes
  deployment record.

For Sepolia, reads use the configured RPC first and then PublicNode, 1RPC, and Tenderly's public
endpoint. Set `SHAPES_RPC_URL` for the server-side OG route and `NEXT_PUBLIC_SHAPES_RPC_URL` for
browser reads when a paid/provider RPC is available. Requests are unbatched because shared site
reads already use Multicall3 and local seed demos can exceed Anvil's batch-size limit.

`NEXT_PUBLIC_AUCTION_START_HIDDEN=1` hides a scheduled auction's start date and countdown in
`AuctionView`, showing only "Not open". Unset leaves the date and countdown
visible.

### Indexer proxy

The browser never queries the Ponder indexer directly. Every indexer read goes to `/api/indexer`
on the site's own origin (`app/api/indexer/route.ts`), which forwards the GraphQL query to the
upstream server and returns its JSON. `ShapesProviders` sets `dep.indexerUrl` to that path, so the
upstream origin is not part of any client bundle or deployment record.

- `SHAPES_INDEXER_URL` — the upstream Ponder GraphQL endpoint, including `/graphql`
  (currently `https://shapes-indexer-mainnet.fly.dev/graphql` in production Netlify).
  Server-only, never `NEXT_PUBLIC_`.
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
so the CDN absorbs the site's polling; POST is `no-store`. The response also carries
`Netlify-Vary: query`: Netlify's cache key ignores the query string by default, and without the
directive every GET to `/api/indexer` shares one cached body for the cache window, so a gallery
query is answered with whichever query was cached first.

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

## FWA contribution page

`/fwa` starts with a 1 ETH budget and the Balanced strategy, matching each pack's
FWA backing to its value where current limits allow. Most positions and Lower draw
exposure are available under Customize. Recommendations use live denominations,
mint fees, FWA minimums, and the oracle ceiling, with a 24-position workflow limit.
The current fork's 1 ETH example recommends fifteen 0.03 ETH packs for 0.945 ETH
including separate backing and mint fees. The remaining budget stays in the wallet.
Manual edits preserve pack values, backing, and quantities when the budget changes;
the budget section offers an explicit recalculation action. All position artwork is
shown by default through the canonical `shapes-render` pack renderer, without
cropping. Pack construction and per-position backing remain editable.

All amounts use bigint wei. Pack composition uses the fewest shapes from the
live denomination ladder, with one live mint fee per underlying shape. The total
includes redeemable pack value, FWA backing, and mint fees. Budget and wallet
shortfalls leave every chosen amount unchanged and disable the primary action.
Pack minimums, FWA backing minimums, admission, oracle policy, and withdrawal
status are checked against deployed contracts. Unmet requirements identify the
pack in the editor and contribution summary. The workflow is blocked while the
collection is awaiting admission.

After the cost review, a separate checklist presents one transaction at a time:
approve FWA if necessary, then mint and deposit each pack in plan order. The next
transaction starts after the previous confirmation by default; a saved toggle
pauses between transactions. Each write still needs wallet confirmation. Every write is quoted, simulated,
estimated with the existing gas buffer, and checked against the connected wallet
and chain. The main V2 pool accepts one pack per deposit transaction. The
checklist shows exact pack and FWA backing payments, confirmation progress,
rejected and reverted actions, staged deposits, and transaction links. Mainnet
links open evm.now and FWA Manage; local-fork links open an in-app Anvil receipt.

A wallet-scoped local checklist stores the frozen plan and each broadcast hash
before awaiting confirmation. Reload recovery reads receipts, extracts the actual
pack/listing IDs, detects nonce replacements, and distinguishes staged deposits. The original wallet remains
the FWA depositor. Do not clear browser storage during a workflow; packs and
positions themselves remain onchain regardless of this checklist. Plans do not
include gas. Sessions created by the earlier mint-all workflow retain their
original transaction order when resumed.

Validation:

```sh
node --import tsx --test preview/src/site/fwa.test.ts
# Install Anvil through Foundry, then run against a disposable mainnet fork:
node web/e2e/runFwaFork.mjs
# Optional: ANVIL_BIN=/absolute/path/to/anvil FWA_FORK_SOURCE=https://your.rpc
SHAPES_LADDER=mainnet npm run build --workspace web
```

The fork check uses the real deployed contracts, funds a disposable test wallet,
mints packs, checks actual admission rejection when applicable, and enables the
announced collection admission/exemption using owner impersonation **on the local
fork only**. It verifies direct wallet depositor rights and reload recovery from
actual receipts. The script refuses non-loopback RPCs and requires Anvil before
any write. Its state is reverted and its node stopped after the run. No test
transaction is submitted to Ethereum mainnet.

For a browser-connected FWA fork, use Anvil on the default `127.0.0.1:8545`
with chain ID `31337` and `https://mainnet.gateway.tenderly.co` as its pinned
mainnet source. Set `SHAPES_DEPLOYMENT_FILE` to a values-only deployment record
with that loopback RPC and chain ID, then run
`node web/scripts/mark-fwa-fork.mjs`. The script installs or reuses a public
1-wei fork marker, resolves `ripe0x.eth` through Tenderly mainnet RPC, and
ensures that wallet has at least 1,000 test ETH on Anvil. It records the public
addresses in the deployment file. Re-run it after resetting or replacing Anvil,
then rebuild or reload the frontend. FWA writes
check the marker through both the page RPC and wallet provider before signing;
a missing or mismatched marker blocks the transaction.

### FWA preview branch

`feat/fwa-packs` has a branch specific Netlify context in `netlify.toml`. It
builds the real mainnet app on every update and uses `DEPLOY_PRIME_URL` for the
preview's metadata origin. Production configuration is unchanged.

In the mainnet Netlify project's **Branches and deploy contexts** settings,
enable Deploy Previews for pull requests and add `feat/fwa-packs` to the specific
branches allowed for branch deploys. Netlify then rebuilds its stable preview URL
on pushes to this branch. PR #149 sets `@netlify /fwa` as its preview entry page.
These account settings must be enabled in Netlify; the TOML context supplies build
configuration but does not enable Git integration or branch deploys by itself.

## Initial load

Bundled production routes prerender a public header and loading shell. The wallet stack mounts after hydration and the live denomination
check; amounts and transaction controls remain behind successful validation. Core app and wallet
modules preload with the document so they do not introduce another download waterfall. Optional views load on demand and desktop navigation
preloads its destination on hover/focus. Wallet cookies are decoded in the browser before the
persistent wallet provider first mounts, so public HTML never contains an account connection.

Set deployment/indexer configuration before building. For local records, supply
`SHAPES_DEPLOYMENT_FILE` at both build and start (as `e2e/run.sh` does); those builds retain dynamic
rendering so changes to the local record are read at request time. A bundled static build needs a
rebuild when its deployment or indexer configuration changes. Never retarget a production static
artifact by supplying a different deployment file only at start.

Focused local production checks (real local mainnet fork; no mainnet transactions):

```sh
E2E_BASE_URL=http://127.0.0.1:3197 E2E_RPC_URL=http://127.0.0.1:8597 node web/e2e/startupBrowser.mjs
BASELINE_URL=http://127.0.0.1:3196 E2E_BASE_URL=http://127.0.0.1:3197 node web/e2e/startupPerformance.mjs
```

Both performance builds must use the same deployment, RPC and public WalletConnect project
configuration. The performance check uses three fresh contexts per profile/build, an eight-second
observation window, and a second profile with 100 ms latency, 200,000 bytes/s download and 4x CPU
slowdown. Set `PLAYWRIGHT_CHROME_PATH` when using an installed Chrome. Hosted CDN cache behavior
still needs a post-deployment readback.
