import { baseAllowList, baseBlockList, isWakuLoaded, wakuClient } from "./connect-waku";

/**
 * Undefined, not `[]`, until a mutation gives them content.
 *
 * The SDK's rule is `!allowlist || allowlist.includes(address)`. An empty ARRAY
 * is truthy, so it does not mean "no restriction" — it means `[].includes(...)`
 * for every candidate, which admits nobody. Seeded with `[]` these filters
 * silently hid every broadcaster the first time one was blocked, before the
 * allow list had been populated with anything.
 */
let currentAllowList: Optional<string[]> = undefined;
let currentBlockList: Optional<string[]> = undefined;

/** A mutable copy, so pushing to a filter never edits the base list in place. */
const startFrom = (base: Optional<string[]>): string[] => [...(base ?? [])];

export const addRemovedBroadcaster = (broadcasterAddress: string) => {
  if (!isWakuLoaded()) {
    throw new Error("Waku Client is not Loaded");
  }
  if (!wakuClient) {
    return;
  }
  if (!currentBlockList) {
    currentBlockList = startFrom(baseBlockList);
  }
  currentBlockList.push(broadcasterAddress);
  // Blocking must not widen the allow list. Left undefined it would, so carry
  // the base restriction forward untouched.
  currentAllowList ??= baseAllowList;
  // Both lists, every time. Passing `undefined` here cleared the allow list as
  // a side effect of blocking someone, so the two setters disagreed about what
  // the filters were and whichever ran last won.
  wakuClient.setAddressFilters(currentAllowList, currentBlockList);
};

export const addChosenBroadcaster = (broadcasterAddress: string) => {
  if (!isWakuLoaded()) {
    throw new Error("Waku Client is not Loaded");
  }
  if (!wakuClient) {
    return;
  }
  if (!currentAllowList) {
    currentAllowList = startFrom(baseAllowList);
  }
  currentAllowList.push(broadcasterAddress);
  wakuClient.setAddressFilters(currentAllowList, currentBlockList);
};

export const resetBroadcasterFilters = () => {
  if (!isWakuLoaded()) {
    throw new Error("Waku Client is not Loaded");
  }
  if (!wakuClient) {
    return;
  }
  currentAllowList = baseAllowList;
  currentBlockList = baseBlockList;
  wakuClient.setAddressFilters(currentAllowList, currentBlockList);
};
