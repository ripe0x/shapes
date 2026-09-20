# shapes-sdk

The canonical Shapes renderer and a typed client for the Shapes indexer's public API. No app
should read a Shape's art or metadata from the chain directly; this package and the indexer it
talks to are the answer (`project/tasks/SHAPES-API.md`).

## Render module

`src/render/` is the canonical TypeScript renderer, moved here from `preview/src/canonical/` so
every consumer (the indexer, the site, `preview`, a third party) shares one implementation.
`src/ShapeRenderer.sol` is a line-by-line Solidity port of it; the parity suite asserts
byte-identical output.

```ts
import { renderShapeSvg } from "shapes-sdk/render";

const svg = renderShapeSvg({
  tokenId: 123n,
  seed: "0x...", // the token's seed, as stored
  denomIndex: 4, // 0..8, the ladder index
  inkGene: 3, // 0..6
  modules: null, // stored module bytes, or null/undefined for seed-derived geometry
  isBlack: false,
});
```

`renderShapeSvg` reproduces exactly what `Shapes.svg(tokenId)` returns, computed only from these
fields — no RPC, no chain read. This is what the indexer's `/v1/:chainId/shape/:id/:version.svg`
route runs on every request.

## API client

```ts
import { ShapesApi } from "shapes-sdk/client";

const api = new ShapesApi(); // defaults to https://api.shapes.ripe.wtf

const shape = await api.shape(1, 123); // GET /v1/1/shape/123.json
const owned = await api.shapes(1, { owner: "0x..." }); // GET /v1/1/shapes?owner=0x...
const url = api.artUrl(1, 123, shape.version); // no network call
```

`https://api.shapes.ripe.wtf` is the public edge hostname documented in `indexer/README.md`
("Public hostname"); it proxies to whichever indexer app serves the requested chain. Pass
`baseUrl` to talk to one indexer app's own origin instead (local dev, or bypassing the edge
cache), and `fetch` to inject a different fetch implementation (tests, a non-browser runtime).

None of the three calls needs auth: the v1 routes are open, CORS-enabled, rate limited per IP.

## Address book

```ts
import { deploymentFor, shapesAbi } from "shapes-sdk/deployments";

const mainnet = deploymentFor(1); // deployments/1.json
const sepolia = deploymentFor(11155111); // deployments/11155111.json
```

Reads `deployments/<chainId>.json` and `indexer/abis/*` directly rather than duplicating them;
those files are this repo's source of truth for addresses and ABIs.

## Tests

```bash
npm --workspace packages/shapes-sdk test
```

`src/render/*.test.ts` is the moved canonical renderer's own unit suite (module codec, sampling,
metadata). `src/client.test.ts` and `src/deployments.test.ts` cover the client and address book.
`src/parity.test.ts` renders ten live Sepolia tokens from the deployed indexer's own rows and
compares them to `Shapes.svg(tokenId)` on chain; it skips (rather than fails) when the Sepolia
indexer or an RPC is unreachable from the current environment, since it is the one test in this
package that depends on live infrastructure this package does not control.
