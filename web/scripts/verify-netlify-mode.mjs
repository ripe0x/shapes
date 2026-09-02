const mode = process.env.SHAPES_SITE_MODE;
const publicUrl = process.env.NEXT_PUBLIC_SITE_URL;
const ladder = process.env.SHAPES_LADDER || "mainnet";

function fail(message) {
  console.error(`Netlify build refused: ${message}`);
  process.exit(1);
}

if (mode !== "landing" && mode !== "app" && mode !== "hybrid") {
  fail("SHAPES_SITE_MODE must be exactly 'landing', 'app', or 'hybrid'.");
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

if (mode === "app") {
  if (publicUrl === "https://shapes.ripe.wtf") {
    fail("app mode cannot claim the production launch URL.");
  }
  if (ladder !== "testnet") {
    fail("the deployed Sepolia app requires SHAPES_LADDER=testnet.");
  }
}

if (mode === "hybrid") {
  if (publicUrl !== "https://shapes.ripe.wtf") {
    fail("hybrid mode requires NEXT_PUBLIC_SITE_URL=https://shapes.ripe.wtf.");
  }
  if (ladder !== "testnet") {
    fail("the hybrid Sepolia app requires SHAPES_LADDER=testnet.");
  }
  if (process.env.SHAPES_CHAIN_ID && process.env.SHAPES_CHAIN_ID !== "11155111") {
    fail("hybrid mode may only target Sepolia (chain id 11155111).");
  }
}

console.log(`Netlify mode verified: ${mode}`);
