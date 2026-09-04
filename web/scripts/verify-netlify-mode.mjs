const mode = process.env.SHAPES_SITE_MODE || "app";
const publicUrl = process.env.NEXT_PUBLIC_SITE_URL;

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
}

// App mode builds for any URL.

console.log(`Netlify mode verified: ${mode}`);
