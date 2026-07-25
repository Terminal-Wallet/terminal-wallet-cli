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
  wakuClient.setAddressFilters(undefined, currentBlockList);
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
