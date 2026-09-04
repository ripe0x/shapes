import assert from "node:assert/strict";
import test from "node:test";
import {indexerQuery} from "./indexerClient";

const OK = {data: {activitys: {items: []}}};

function capture(): {calls: {url: string; init: RequestInit | undefined}[]; fetch: typeof fetch} {
  const calls: {url: string; init: RequestInit | undefined}[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({url: String(url), init});
    return new Response(JSON.stringify(OK), {status: 200, headers: {"content-type": "application/json"}});
  }) as typeof fetch;
  return {calls, fetch: fetcher};
}

test("a same-origin path is the site's proxy: GET with the query in the URL, no body", async () => {
  const {calls, fetch: fetcher} = capture();
  await indexerQuery("/api/indexer", fetcher, "{ activitys { items { id } } }", {limit: 3});

  const call = calls[0]!;
  const url = new URL(call.url, "http://site.test");
  assert.equal(url.pathname, "/api/indexer");
  assert.equal(url.searchParams.get("query"), "{ activitys { items { id } } }");
  assert.deepEqual(JSON.parse(url.searchParams.get("variables")!), {limit: 3});
  assert.equal(call.init?.method, "GET");
  assert.equal(call.init?.body, undefined);
});

test("an absolute URL is a Ponder origin: POST to its /graphql endpoint", async () => {
  const {calls, fetch: fetcher} = capture();
  await indexerQuery("http://indexer.test/", fetcher, "{ activitys { items { id } } }", {limit: 3});

  const call = calls[0]!;
  assert.equal(call.url, "http://indexer.test/graphql");
  assert.equal(call.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    query: "{ activitys { items { id } } }",
    variables: {limit: 3},
  });
});
