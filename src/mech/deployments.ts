import {
  AbiCoder,
  concat,
  getCreate2Address,
  Interface,
  keccak256,
  TransactionRequest,
} from "ethers";
import {
  RailgunProxyContract,
  RelayAdaptContract,
} from "@railgun-community/shared-models";

import { getCurrentNetwork } from "../engine/engine";
import { getCurrentEthersWallet } from "../wallet/public-utils";
import { encodeCreateAccount } from "./encode";
import configDefaults from "../config/config-defaults";

const config = {
  erc6551Registry: {
    address: "0x000000006551c19487814612e58FE06813775758",
  },
  mechMastercopy: {
    address: "0xC62046fBbcF02725949Afeab16dcf75f5066E2bB",
  },
};

export function railgunSmartWalletAddress() {
  return RailgunProxyContract[getCurrentNetwork()];
}

export function relayAdaptAddress() {
  return RelayAdaptContract[getCurrentNetwork()];
}

export function mechAddress() {
  const { chainId } = configDefaults.networkConfig[getCurrentNetwork()];
  return calculateMechAddress({
    chainId,
    tokenAddress: nftAddress(),
    tokenId: nftTokenId(),
    from: config.erc6551Registry.address,
    salt: mechDeploymentSalt(),
  });
}

export function nftAddress() {
  return "0x4529bd704852B3E4b7d043Ea1F866dd2443844Ce";
}

export function nftTokenId() {
  const wallet = getCurrentEthersWallet();
  return BigInt(keccak256(wallet.signMessageSync("RailgunNeuralLink tokenId")));
}

function calculateMechAddress(context: {
  /** Address of the ERC721 token contract */
  chainId: number;
  /** Address of the ERC721 token contract */
  tokenAddress: string;
  /** ID of the ERC721 token */
  tokenId: bigint;
  salt: string;
  from: string;
}) {
  try {
    return getCreate2Address(
      config.erc6551Registry.address,
      context.salt,
      keccak256(erc6551ProxyBytecode(config.mechMastercopy.address, context)),
    );
  } catch (e) {
    console.log(e);
    throw e;
  }
}

export function populateMechDeployment(): TransactionRequest {
  const { chainId } = configDefaults.networkConfig[getCurrentNetwork()];

  return {
    to: config.erc6551Registry.address,
    data: encodeCreateAccount({
      salt: mechDeploymentSalt(),
      chainId,
      tokenAddress: nftAddress(),
      tokenId: nftTokenId(),
    }).data,
  } as TransactionRequest;
}

function erc6551ProxyBytecode(
  implementation: string,
  {
    chainId,
    tokenAddress,
    tokenId,
    salt,
  }: {
    chainId: number;
    tokenAddress: string;
    tokenId: bigint;
    salt?: string;
  },
) {
  return concat([
    "0x3d60ad80600a3d3981f3363d3d373d3d3d363d73",
    implementation,
    "0x5af43d82803e903d91602b57fd5bf3",
    AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "address", "uint256"],
      [salt, chainId, tokenAddress, tokenId],
    ),
  ]);
}

export function populateMint(to: string): TransactionRequest {
  const iface = new Interface([
    "function mint(address to, uint256 tokenId) external",
  ]);

  return {
    to: nftAddress(),
    data: iface.encodeFunctionData("mint", [to, nftTokenId()]),
    value: 0,
  };
}

export function populateApprove(to: string) {
  const iface = new Interface([
    "function approve(address to, uint256 tokenId)",
  ]);

  return {
    to: nftAddress(),
    data: iface.encodeFunctionData("approve", [to, nftTokenId()]),
  };
}

export function mechDeploymentSalt() {
  const wallet = getCurrentEthersWallet();
  return keccak256(wallet.signMessageSync("RailgunMech Deployment"));
}
