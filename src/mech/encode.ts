import { Interface } from "ethers";

export function encodeThroughMech({
  to,
  value,
  data,
  operation,
}: {
  to: string;
  data: string;
  value?: bigint | number;
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

  // Encode calldata
  return iface.encodeFunctionData("transferFrom", [from, to, tokenId]);
}

export function encodeCreateAccount({
  salt,
  chainId,
  tokenAddress,
  tokenId,
}: {
  salt: string;
  chainId: number | bigint;
  tokenAddress: string;
  tokenId: bigint;
}) {
  const erc6551Registry = "0x000000006551c19487814612e58FE06813775758";
  const tokenBoundMechMastercopy = "0xC62046fBbcF02725949Afeab16dcf75f5066E2bB";

  const iface = new Interface([
    "error AccountCreationFailed()",
    "event ERC6551AccountCreated(address account, address indexed implementation, bytes32 salt, uint256 chainId, address indexed tokenContract, uint256 indexed tokenId)",
    "function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) view returns (address)",
    "function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)",
  ]);

  return {
    to: erc6551Registry,
    data: iface.encodeFunctionData("createAccount", [
      tokenBoundMechMastercopy,
      salt,
      chainId,
      tokenAddress,
      tokenId,
    ]),
  };
}

// export function encodeDoSomething() {
//   const abi = [
//     "function transfer(address to, uint256 amount)",
//     "function doSomething(uint256 v)",
//   ];

//   // Create an Interface
//   const iface = new Interface(abi);

//   // Encode the function data
//   const data = iface.encodeFunctionData("doSomething", [919289128918298]);
//   return { to: "0x47C2a8aA719877d26a09B79419cBF65ddE833A58", data };
// }
