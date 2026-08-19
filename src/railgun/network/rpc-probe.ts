/**
 * Asking an RPC endpoint whether it is actually there.
 *
 * The provider list records what the user ENABLED, which is a preference, not a
 * fact about the network. An endpoint can be enabled and dead, enabled and
 * rate-limiting, or enabled and quietly hundreds of blocks behind — and all
 * three read as "enabled" in the editor while the wallet quietly fails against
 * them.
 *
 * A block height is the cheapest question that distinguishes them, because it
 * answers "responding" and "current" at once.
 *
 * NOTE the failure shape. A probe that returned 0 on error would render as an
 * endpoint at block zero — a number, next to other numbers, that a reader
 * scans past. Every failure here is a distinct variant carrying its reason, so
 * a caller cannot accidentally treat "could not ask" as an answer.
 */

/** The endpoint answered with a height. */
export interface RpcProbeOk {
  ok: true;
  blockNumber: bigint;
  /** Round-trip in ms, for picking between two that both work. */
  latencyMs: number;
}

/** It did not. `reason` is already worded for display. */
export interface RpcProbeFail {
  ok: false;
  reason: string;
}

export type RpcProbe = RpcProbeOk | RpcProbeFail;

/** Long enough for a cold serverless endpoint, short enough to not hang a modal. */
export const RPC_PROBE_TIMEOUT_MS = 5_000;

/**
 * Turn whatever came back into either a height or a reason.
 *
 * Split from the request so the parsing — which is where the surprises are —
 * is testable without a network. Endpoints are not uniform here: some answer a
 * JSON-RPC error object with HTTP 200, some send HTML from a proxy, and some
 * return a result that is not a hex quantity at all.
 */
export const parseBlockNumberResponse = (body: unknown): RpcProbe => {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "not JSON-RPC" };
  }
  const rec = body as Record<string, unknown>;
  const err = rec.error;
  if (err !== undefined && err !== null) {
    const message =
      typeof err === "object" && err !== null && "message" in err
        ? String((err as Record<string, unknown>).message)
        : String(err);
    // Rate limits are the common one and are worth naming: the endpoint is
    // alive and the right answer is to use it less, not to remove it.
    return { ok: false, reason: message.slice(0, 60) };
  }
  const { result } = rec;
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) {
    return { ok: false, reason: "bad result" };
  }
  const blockNumber = BigInt(result);
  // A syncing node can legitimately answer 0, but so can a mock or a stub that
  // does not implement the method. Either way it is not a usable endpoint, and
  // calling it out beats rendering "block 0" beside real heights.
  if (blockNumber === 0n) return { ok: false, reason: "reports block 0" };
  return { ok: true, blockNumber, latencyMs: 0 };
};

/**
 * Ask one endpoint for its head block.
 *
 * Deliberately a bare fetch rather than an ethers provider: a provider retries,
 * caches and can be pointed at a fallback, all of which would hide exactly the
 * per-endpoint truth being asked for.
 */
export const probeRpcEndpoint = async (
  url: string,
  timeoutMs: number = RPC_PROBE_TIMEOUT_MS,
  now: () => number = () => Date.now(),
): Promise<RpcProbe> => {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const parsed = parseBlockNumberResponse(await res.json());
    return parsed.ok ? { ...parsed, latencyMs: now() - started } : parsed;
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : error instanceof Error
          ? error.message.slice(0, 60)
          : "unreachable";
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
};
