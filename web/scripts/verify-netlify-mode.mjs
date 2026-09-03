const mode = process.env.SHAPES_SITE_MODE || "app";
const publicUrl = process.env.NEXT_PUBLIC_SITE_URL;
const ladder = process.env.SHAPES_LADDER || "mainnet";

function fail(message) {
  console.error(`Netlify build refused: ${message}`);
  process.exit(1);
}

if (mode !== "landing" && mode !== "app") {
  fail("SHAPES_SITE_MODE must be exactly 'landing' or 'app' (unset defaults to 'app').");
}

if (mode === "landing") {
  if (publicUrl !== "https://shapes.ripe.wtf") {
    fail("landing mode requires NEXT_PUBLIC_SITE_URL=https://shapes.ripe.wtf.");
  }
  if (ladder !== "mainnet") {
    fail("landing mode cannot build with the testnet denomination ladder.");
  }
  if (process.env.SHAPES_CHAIN_ID === "11155111") {
    fail("landing mode cannot carry the Sepolia chain id.");
  }
}

// App mode builds for any URL and any ladder; next.config.ts checks the ladder against the
// selected deployment record's chain id.

console.log(`Netlify mode verified: ${mode}`);
