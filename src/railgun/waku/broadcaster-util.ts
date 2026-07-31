import { baseAllowList, baseBlockList, isWakuLoaded, wakuClient } from "./connect-waku";

let currentAllowList: Optional<string[]> = [];
let currentBlockList: Optional<string[]> = [];

export const addRemovedBroadcaster = (broadcasterAddress: string) => {
  if (!isWakuLoaded()) {
    throw new Error("Waku Client is not Loaded");
  }
  if (!wakuClient) {
    return;
  }
  if (!currentBlockList) {
    currentBlockList = baseBlockList;
  }
  currentBlockList?.push(broadcasterAddress);
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
    currentAllowList = baseAllowList;
  }
  currentAllowList?.push(broadcasterAddress);
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
