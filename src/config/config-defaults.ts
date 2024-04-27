import {
  ChainType,
  NetworkName,
  type ProviderJson,
} from "@railgun-community/shared-models";
import {
  TokenAddressArbitrum,
  TokenAddressBSC,
  TokenAddressEthereum,
  TokenAddressPolygonPOS,
} from "../models/token-models";
import { getProviderObjectFromURL } from "../models/network-models";

interface ConfigDefaults {
  apiKeys: {
    zeroXApi: string;
  };
  engine: {
    artifactPath: string;
    databasePath: string;
    keyChainPath: string;
    defaultChain: NetworkName;
    defaultNetworks: NetworkName[];
  };
  tokenConfig: {
    [key in NetworkName]: string[];
  };
  networkConfig: {
    [key in NetworkName]: {
      name: string;
      type: ChainType;
      chainId: number;
      blockscan: string;
      providers: ProviderJson[];
    };
  };
}

export default {
  apiKeys: {
    zeroXApi: "50451a60-e839-4f7e-a971-bfef488de1cb",
  },
  engine: {
    artifactPath: ".artifacts",
    databasePath: ".railgun.db",
    keyChainPath: ".zKeyChains",
    defaultChain: NetworkName.Ethereum,
    defaultNetworks: [
      NetworkName.Ethereum,
      NetworkName.BNBChain,
      NetworkName.Polygon,
      NetworkName.Arbitrum,
    ],
  },
  tokenConfig: {
    [NetworkName.Ethereum]: [
      TokenAddressEthereum.USDT,
      TokenAddressEthereum.WETH,
      TokenAddressEthereum.WBTC,
      TokenAddressEthereum.WBTC,
      TokenAddressEthereum.DAI,
      TokenAddressEthereum.USDC,
      TokenAddressEthereum.RAIL,
    ],
    [NetworkName.BNBChain]: [
      TokenAddressBSC.BTCB,
      TokenAddressBSC.BUSD,
      TokenAddressBSC.CAKE,
      TokenAddressBSC.DAI,
      TokenAddressBSC.ETH,
      TokenAddressBSC.RAILBSC,
      TokenAddressBSC.USDC,
      TokenAddressBSC.USDT,
      TokenAddressBSC.WBNB,
    ],
    [NetworkName.Polygon]: [
      TokenAddressPolygonPOS.BNB,
      TokenAddressPolygonPOS.DAI,
      TokenAddressPolygonPOS.RAILPOLY,
      TokenAddressPolygonPOS.USDC,
      TokenAddressPolygonPOS.USDT,
      TokenAddressPolygonPOS.WBTC,
      TokenAddressPolygonPOS.WETH,
      TokenAddressPolygonPOS.WMATIC,
    ],
    [NetworkName.Arbitrum]: [
      TokenAddressArbitrum.ARB,
      TokenAddressArbitrum.DAI,
      TokenAddressArbitrum.TUSD,
      TokenAddressArbitrum.UNI,
      TokenAddressArbitrum.USDC,
      TokenAddressArbitrum.USDT,
      TokenAddressArbitrum.WBTC,
      TokenAddressArbitrum.WETH,
    ],
    [NetworkName.ArbitrumGoerli_DEPRECATED]: [],
    [NetworkName.EthereumSepolia]: [],
    [NetworkName.PolygonMumbai_DEPRECATED]: [],
    [NetworkName.PolygonAmoy]: [],
    [NetworkName.Hardhat]: [],
    [NetworkName.EthereumGoerli_DEPRECATED]: [],
    [NetworkName.EthereumRopsten_DEPRECATED]: [],
  },
  networkConfig: {
    [NetworkName.Ethereum]: {
      name: "Ethereum",
      type: ChainType.EVM,
      chainId: 1,
      blockscan: "https://etherscan.io/",
      providers: [
        getProviderObjectFromURL("https://rpc.ankr.com/eth"),
        getProviderObjectFromURL("https://cloudflare-eth.com/"),
        getProviderObjectFromURL("https://ethereum.publicnode.com"),
      ],
    },
    [NetworkName.Polygon]: {
      name: "Polygon",
      type: ChainType.EVM,
      chainId: 137,
      blockscan: "https://polygonscan.com/",
      providers: [
        getProviderObjectFromURL("https://rpc-mainnet.matic.quiknode.pro"),
        getProviderObjectFromURL("https://polygon-bor.publicnode.com"),
        getProviderObjectFromURL("https://polygon-rpc.com"),
        getProviderObjectFromURL("https://rpc-mainnet.maticvigil.com"),
      ],
    },
    [NetworkName.BNBChain]: {
      name: "Binance",
      type: ChainType.EVM,
      chainId: 56,
      blockscan: "https://bscscan.com/",
      providers: [
        getProviderObjectFromURL("https://bsc.blockpi.network/v1/rpc/public"),
        getProviderObjectFromURL("https://bsc.rpc.blxrbdn.com"),
        getProviderObjectFromURL("https://bsc-dataseed4.defibit.io"),
        getProviderObjectFromURL("https://bsc-dataseed2.binance.org"),
      ],
    },
    [NetworkName.Arbitrum]: {
      name: "Arbitrum",
      blockscan: "https://arbiscan.io/",
      type: ChainType.EVM,
      chainId: 42161,
      providers: [
        getProviderObjectFromURL(
          "https://endpoints.omniatech.io/v1/arbitrum/one/public",
        ),
        getProviderObjectFromURL("https://arbitrum-one.publicnode.com"),
        getProviderObjectFromURL("https://arbitrum.meowrpc.com	"),
        getProviderObjectFromURL("https://arbitrum-one.public.blastapi.io"),
      ],
    },
    [NetworkName.EthereumGoerli_DEPRECATED]: {
      chainId: 5,
      type: ChainType.EVM,
      name: "Görli Testnet",
      blockscan: "https://goerli.etherscan.io/",
      providers: [
        getProviderObjectFromURL("https://gateway.tenderly.co/public/goerli"),
        getProviderObjectFromURL("https://ethereum-goerli.publicnode.com"),
        getProviderObjectFromURL("https://eth-goerli.public.blastapi.io"),
      ],
    },
    [NetworkName.ArbitrumGoerli_DEPRECATED]: {
      chainId: 421613,
      type: ChainType.EVM,
      name: "Arbitrum Görli Testnet",
      blockscan: "https://goerli.arbiscan.io/",
      providers: [
        getProviderObjectFromURL(
          "https://arbitrum-goerli.blockpi.network/v1/rpc/public",
        ),
        getProviderObjectFromURL("https://arbitrum-goerli.publicnode.com"),
        getProviderObjectFromURL("https://rpc.goerli.arbitrum.gateway.fm"),
        getProviderObjectFromURL("https://arbitrum-goerli.public.blastapi.io"),
      ],
    },
    [NetworkName.EthereumSepolia]: {
      chainId: 11155111,
      type: ChainType.EVM,
      name: "Sepolia Testnet",
      blockscan: "https://sepolia.etherscan.io/",
      providers: [
        getProviderObjectFromURL("https://rpc.ankr.com/eth_sepolia"),
        getProviderObjectFromURL(
          "https://ethereum-sepolia.blockpi.network/v1/rpc/public",
        ),
        getProviderObjectFromURL("https://ethereum-sepolia.publicnode.com"),
      ],
    },
    [NetworkName.EthereumRopsten_DEPRECATED]: {
      chainId: 1337,
      providers: [],
      name: "EthereumRopsten_DEPRECATED",
      blockscan: "",
      type: ChainType.EVM,
    },
    [NetworkName.PolygonMumbai_DEPRECATED]: {
      chainId: 1337,
      providers: [],
      name: "PolygonMumbai",
      blockscan: "",
      type: ChainType.EVM,
    },
    [NetworkName.PolygonAmoy]: {
      chainId: 1337,
      providers: [],
      name: "PolygonMumbai",
      blockscan: "",
      type: ChainType.EVM,
    },

    [NetworkName.Hardhat]: {
      chainId: 1337,
      providers: [],
      name: "Hardhat",
      blockscan: "",
      type: ChainType.EVM,
    },
  },
} as ConfigDefaults;
