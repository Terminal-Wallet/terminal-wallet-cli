// import { zeroPadValue } from "ethers";

// import { NFTTokenType } from "@railgun-community/wallet";

// import { mechStatus } from "./status";
// import {
//   mechAddress,
//   nftAddress,
//   populateApprove,
//   populateMechDeployment,
//   populateMint,
//   railgunSmartWalletAddress,
// } from "../deployments";
// import {
//   getCurrentRailgunAddress,
//   getCurrentRailgunID,
// } from "../../wallet/wallet-util";
// import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
// import { getCurrentNetwork } from "../../engine/engine";
// import { populateShieldTransaction } from "../populate/populateShieldTransaction";

// import { getCurrentEthersWallet } from "../../wallet/public-utils";

// export async function deployMech() {
//   const { isMechDeployed, isNFTMinted, isNFTShielded, isNFTSpendable } =
//     await mechStatus();

//   if (!isNFTMinted) {
//     console.log("Minting NFT");
//     await sendSelfSignedTransaction(
//       selfSignerInfo(),
//       getCurrentNetwork(),
//       await populateMint(getCurrentEthersWallet().address),
//     );

//     console.log("Waiting 5 secs for mint");
//     await sleep(5000);

//     console.log("Approving NFT");
//     await sendSelfSignedTransaction(
//       selfSignerInfo(),
//       getCurrentNetwork(),
//       await populateApprove(railgunSmartWalletAddress()),
//     );

//     console.log("Waiting 5 secs for approve");
//     await sleep(5000);
//   } else {
//     console.log("NFT already minted");
//   }

//   if (!isNFTShielded) {
//     console.log("Shielding NFT");

//     await sendSelfSignedTransaction(
//       selfSignerInfo(),
//       getCurrentNetwork(),
//       await populateShieldTransaction({
//         nftIn: [
//           {
//             nftAddress: nftAddress(),
//             nftTokenType: NFTTokenType.ERC721,
//             tokenSubID: zeroPadValue(mechAddress(), 32),
//             amount: BigInt(1),
//             recipientAddress: getCurrentRailgunAddress(),
//           },
//         ],
//         erc20In: [],
//       }),
//     );
//   } else {
//     console.log("NFT already shielded");
//   }

//   if (!isMechDeployed) {
//     console.log("Deploying Mech");
//     await sendSelfSignedTransaction(
//       selfSignerInfo(),
//       getCurrentNetwork(),
//       await populateMechDeployment(),
//     );
//   } else {
//     console.log("Mech already deployed");
//   }
// }

// function selfSignerInfo() {
//   return {
//     railgunWalletID: getCurrentRailgunID(),
//     railgunWalletAddress: getCurrentRailgunAddress(),
//     derivationIndex: 0,
//   };
// }

// function sleep(ms: number) {
//   return new Promise((resolve) => setTimeout(resolve, ms));
// }
