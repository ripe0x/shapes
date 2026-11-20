import {custom, http, HttpRequestError, type EIP1193Parameters, type Transport} from "viem";

interface RpcLimits {
  requestsPerSecond?: number;
  maxConcurrent?: number;
  windowMs?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  timeoutMs?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const coolingDown = Symbol("RPC provider cooling down");

async function errorBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < 16_384) {
      const {done, value} = await reader.read();
      if (done) break;
      text += decoder.decode(value.subarray(0, 16_384 - bytes), {stream: true});
      bytes += value.length;
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function errorDetails(error: unknown): {transient: boolean; deterministic: boolean; reason: string} {
  let current = error;
  const seen = new Set<unknown>();
  const causes: {code?: number; status?: number; name?: string; message?: string; details?: string; cause?: unknown}[] = [];
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as typeof causes[number];
    causes.push(value);
    current = value.cause;
  }
  const message = causes.map((cause) => `${cause.message ?? ""} ${cause.details ?? ""}`).join(" ");
  // Authentication failures are permanent even when the response body uses a limit error code.
  const status = causes.find((cause) => cause.status !== undefined)?.status;
  if (status === 401 || status === 403) return {transient: false, deterministic: false, reason: String(status)};
  // Ponder must receive request-size errors so its existing range splitter can adjust the query.
  if (/block range|query (?:returned|exceeds)|response (?:size|too large)|logs matched|requested too many blocks|maximum allowed number/i.test(message)) {
    return {transient: false, deterministic: true, reason: "RPC request size"};
  }
  if (causes.some((cause) => cause.name === "SyntaxError")) {
    return {transient: false, deterministic: false, reason: "malformed response"};
  }
  if (/archive requests require|personal token/i.test(message)) {
    return {transient: false, deterministic: false, reason: "archive access"};
  }
  const deterministic = causes.find((cause) => cause.code === -32600 || cause.code === -32602 ||
    cause.code === 3 || /execution reverted/i.test(cause.message ?? ""));
  if (deterministic) return {transient: false, deterministic: true, reason: String(deterministic.code ?? "revert")};
  if (status !== undefined) {
    return {transient: status === 408 || status === 429 || status >= 500, deterministic: false, reason: String(status)};
  }
  const limited = causes.find((cause) => cause.code === -32005);
  if (limited) return {transient: /rate.?limit|too many requests|throttl|request quota|bandwidth|egress|compute units/i.test(message),
    deterministic: !/rate.?limit|too many requests|throttl|request quota|bandwidth|egress|compute units/i.test(message), reason: "-32005"};
  if (causes.some((cause) => cause.code === -32603)) return {transient: true, deterministic: false, reason: "-32603"};
  return {transient: causes.some((cause) => cause.name === "HttpRequestError" || cause.name === "TimeoutError"),
    deterministic: false, reason: "RPC error"};
}

/** Ordered failover with one shared budget per URL, including Ponder's startup diagnostic. */
export function boundedRpcTransport(urls: readonly string[], chainId: number, limits: RpcLimits = {}): Transport {
  const {
    requestsPerSecond = 5,
    maxConcurrent = 2,
    windowMs = 1_000,
    cooldownMs = 30_000,
    maxCooldownMs = 300_000,
    timeoutMs = 10_000,
  } = limits;
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !urls.length ||
      [requestsPerSecond, maxConcurrent, windowMs, cooldownMs, maxCooldownMs, timeoutMs]
        .some((n) => !Number.isSafeInteger(n) || n <= 0) || maxCooldownMs < cooldownMs) {
    throw new Error("Invalid RPC chain, providers, or request limits");
  }

  const providers = [...new Set(urls)].map((url) => {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("RPC providers must use HTTP or HTTPS");
    const starts: number[] = [];
    return {
      hostname: parsed.hostname,
      request: http(url, {
        retryCount: 0,
        timeout: timeoutMs,
        async fetchFn(input, init) {
          while (true) {
            const now = Date.now();
            while (starts.length && starts[0]! <= now - windowMs) starts.shift();
            if (starts.length < requestsPerSecond) {
              starts.push(now);
              break;
            }
            await wait(starts[0]! + windowMs - now);
          }
          // viem's timeout ends at headers; this signal also bounds the response body and frees the slot.
          const signal = AbortSignal.timeout(timeoutMs);
          return fetch(input, {...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal});
        },
        async onFetchResponse(response) {
          if (!response.ok) {
            const details = await errorBody(response).catch(() => "");
            // viem otherwise drops the HTTP status when the body contains a JSON-RPC error.
            const error = new HttpRequestError({status: response.status, url: parsed.origin, details});
            try {
              const body = JSON.parse(details);
              if (typeof body?.error?.code === "number") Object.assign(error, {code: body.error.code});
            } catch {}
            throw error;
          }
        },
      })({}).request,
      active: 0,
      queue: Promise.resolve(),
      released: undefined as (() => void) | undefined,
      cooldownUntil: 0,
      failures: 0,
      generation: 0,
      permanentWarning: undefined as string | undefined,
      validated: false,
      validation: undefined as Promise<void> | undefined,
    };
  });
  type Provider = typeof providers[number];

  async function acquire(provider: Provider): Promise<boolean> {
    const previous = provider.queue;
    let next!: () => void;
    provider.queue = new Promise<void>((resolve) => { next = resolve; });
    await previous;
    try {
      while (provider.cooldownUntil <= Date.now()) {
        if (provider.active >= maxConcurrent) {
          await new Promise<void>((resolve) => { provider.released = resolve; });
        } else {
          provider.active++;
          return true;
        }
      }
      return false;
    } finally {
      next();
    }
  }

  async function send(provider: Provider, body: EIP1193Parameters): Promise<unknown> {
    if (!await acquire(provider)) throw coolingDown;
    const generation = provider.generation;
    try {
      const result = await provider.request(body);
      if (result === undefined) throw new Error("RPC returned an invalid response");
      provider.permanentWarning = undefined;
      if (generation === provider.generation) {
        if (provider.failures) console.info(`RPC recovered host=${provider.hostname}`);
        provider.failures = 0;
        provider.cooldownUntil = 0;
      }
      return result;
    } catch (error) {
      const details = errorDetails(error);
      if (details.transient && generation === provider.generation) {
        const delay = Math.min(cooldownMs * 2 ** provider.failures, maxCooldownMs);
        provider.failures++;
        provider.generation++;
        provider.cooldownUntil = Date.now() + delay;
        console.warn(`RPC cooling down host=${provider.hostname} method=${body.method} reason=${details.reason} delay_ms=${delay}`);
      } else if (!details.transient && !details.deterministic && details.reason !== provider.permanentWarning) {
        provider.permanentWarning = details.reason;
        console.warn(`RPC provider rejected request host=${provider.hostname} method=${body.method} reason=${details.reason}`);
      }
      throw error;
    } finally {
      provider.active--;
      provider.released?.();
      provider.released = undefined;
    }
  }

  async function validate(provider: Provider): Promise<void> {
    if (provider.validated) return;
    provider.validation ??= (async () => {
      const actualChainId = await send(provider, {method: "eth_chainId"});
      if (typeof actualChainId !== "string" || !/^0x[0-9a-f]+$/i.test(actualChainId) || Number(actualChainId) !== chainId) {
        throw new Error(`Wrong chain from RPC host=${provider.hostname}; expected ${chainId}`);
      }
      provider.validated = true;
    })();
    try {
      await provider.validation;
    } finally {
      provider.validation = undefined;
    }
  }

  return custom({
    async request(body: EIP1193Parameters) {
      while (true) {
        let permanentError: unknown;
        let retry = false;
        for (const provider of providers) {
          if (provider.cooldownUntil > Date.now()) { retry = true; continue; }
          try {
            await validate(provider);
            return await send(provider, body);
          } catch (error) {
            if (error === coolingDown) { retry = true; continue; }
            if (error instanceof Error && error.message.startsWith("Wrong chain from RPC")) throw error;
            const details = errorDetails(error);
            if (details.deterministic) throw error;
            if (details.transient) retry = true;
            else permanentError ??= error;
          }
        }
        const cooling = providers.filter((provider) => provider.cooldownUntil > Date.now());
        if (!cooling.length) {
          if (retry) continue;
          throw permanentError ?? new Error("No RPC provider accepted the request");
        }
        // Keep Ponder's checkpoint/process alive while providers recover, including at startup.
        await wait(Math.max(1, Math.min(...cooling.map((provider) => provider.cooldownUntil)) - Date.now()));
      }
    },
  }, {retryCount: 0, name: "Bounded ordered RPC fallback"});
}
