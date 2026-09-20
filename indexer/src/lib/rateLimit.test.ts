import assert from "node:assert/strict";
import { test } from "node:test";
import { createRateLimiter } from "./rateLimit.ts";

test("allows up to the limit within a window, then refuses", () => {
  const limiter = createRateLimiter(3, 60_000);
  assert.equal(limiter.allow("1.2.3.4"), true);
  assert.equal(limiter.allow("1.2.3.4"), true);
  assert.equal(limiter.allow("1.2.3.4"), true);
  assert.equal(limiter.allow("1.2.3.4"), false);
});

test("tracks keys independently", () => {
  const limiter = createRateLimiter(1, 60_000);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("b"), true);
  assert.equal(limiter.allow("a"), false);
  assert.equal(limiter.allow("b"), false);
});

test("a new window resets the count", async () => {
  const limiter = createRateLimiter(1, 20);
  assert.equal(limiter.allow("x"), true);
  assert.equal(limiter.allow("x"), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(limiter.allow("x"), true);
});
