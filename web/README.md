Next.js site for Shapes.

It imports all UI and chain logic from `../preview/src` via the `@shared` alias (see
`next.config.ts`), so the site cannot drift from the parity-tested canonical renderer.

Chain target comes from `web/public/deployment.json`, with env overrides `SHAPES_RPC_URL`,
`SHAPES_CHAIN_ID`, and `SHAPES_ADDRESS` for the server-side deployment target (see
`app/lib/deployment.ts`).

Deployed via Netlify git auto-deploy from `main` (`web/netlify.toml`).

## Development

Run `npm install` at the repo root (this is an npm workspace), then from `web/`:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).
