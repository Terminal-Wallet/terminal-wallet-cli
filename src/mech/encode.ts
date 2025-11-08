import {
  AbiCoder,
  concat,
  getCreate2Address,
  Interface,
  keccak256,
  ZeroHash,
} from "ethers";

const MECH_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000000bad";

export function encodeMechCreate({
  mastercopy,
  chainId,
  tokenAddress,
  tokenId,
}: {
  mastercopy: string;
  chainId: number | bigint;
  tokenAddress: string;
  tokenId: bigint;
}) {
  const iface = new Interface([
    "function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)",
  ]);

  return iface.encodeFunctionData("createAccount", [
    mastercopy,
    MECH_SALT,
    chainId,
    tokenAddress,
    tokenId,
  ]);
}

export function predictMechAddress({
  factory,
  chainId,
  mastercopy,
  tokenAddress,
  tokenId,
}: {
  factory: string;
  chainId: number;
  mastercopy: string;
  tokenAddress: string;
  tokenId: bigint;
}): string {
  const salt = ZeroHash;
  const eip6551ProxyCreationBytecode = concat([
    "0x3d60ad80600a3d3981f3363d3d373d3d3d363d73",
    mastercopy,
    "0x5af43d82803e903d91602b57fd5bf3",
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "uint256"],
      [salt, chainId, tokenAddress, tokenId],
    ),
  ]);
  return getCreate2Address(
    factory,
    salt,
    keccak256(eip6551ProxyCreationBytecode),
  );
}

export function encodeMechExecute({
  to,
  value,
  data,
  operation,
}: {
  to: string;
  value?: string | bigint | number | undefined | null;
  data: string;
  operation?: number;
}) {
  const iface = new Interface([
    "function execute(address to, uint256 value, bytes calldata data, uint8 operation) public payable returns (bytes memory returnData)",
  ]);
  return iface.encodeFunctionData("execute", [
    to,
    BigInt(value || 0),
    data,
    operation || 0,
  ]);
}

export function encodeMint() {
  const iface = new Interface(["function mint() external"]);

  return iface.encodeFunctionData("mint");
}

export function encodeTranfer(to: string, amount: bigint | number) {
  const iface = new Interface([
    "function transfer(address to, uint256 amount)",
  ]);

  return iface.encodeFunctionData("transfer", [to, amount]);
}

export function encodeTranferFrom(from: string, to: string, tokenId: bigint) {
  const iface = new Interface([
    "function transferFrom(address from, address to, uint256 tokenId)",
  ]);

  return iface.encodeFunctionData("transferFrom", [from, to, tokenId]);
}

export function encodeApprove(to: string, tokenId: bigint) {
  const iface = new Interface([
    "function approve(address to, uint256 tokenId)",
  ]);

  return iface.encodeFunctionData("approve", [to, tokenId]);
}
