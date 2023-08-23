import { isWakuLoaded, wakuClient } from "./connect-waku";

let currentAllowList: Optional<string[]> = [];
let currentBlockList: Optional<string[]> = [];

export const addRemovedRelayer = (relayerAddress: string) => {
  if (!isWakuLoaded()) {
    throw new Error("Waku Client is not Loaded");
  }
  if (!wakuClient) {
    return;
  }
  if (!currentBlockList) {
    currentBlockList = [];
  }
  currentBlockList.push(relayerAddress);
  wakuClient.setAddressFilters(undefined, currentBlockList);
};

export const addChosenRelayer = (relayerAddress: string) => {
  if (!isWakuLoaded()) {
    throw new Error("Waku Client is not Loaded");
  }
  if (!wakuClient) {
    return;
  }
  if (!currentAllowList) {
    currentAllowList = [];
  }
  currentAllowList.push(relayerAddress);
  wakuClient.setAddressFilters(currentAllowList, currentBlockList);
};

export const resetRelayerFilters = () => {
  if (!isWakuLoaded()) {
    throw new Error("Waku Client is not Loaded");
  }
  if (!wakuClient) {
    return;
  }
  currentAllowList = [];
  currentBlockList = [];
  wakuClient.setAddressFilters(undefined, undefined);
};
