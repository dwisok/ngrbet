require('dotenv').config();
require('@nomicfoundation/hardhat-toolbox');

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: { version: '0.8.28', settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 } } },
  networks: {
    robinhood: {
      url: process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com',
      chainId: 4663,
      accounts,
    },
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com',
      chainId: 46630,
      accounts,
    },
  },
  etherscan: {
    apiKey: { robinhood: 'blockscout', robinhoodTestnet: 'blockscout' },
    customChains: [
      {
        network: 'robinhood',
        chainId: 4663,
        urls: { apiURL: 'https://robinhoodchain.blockscout.com/api', browserURL: 'https://robinhoodchain.blockscout.com' },
      },
      {
        network: 'robinhoodTestnet',
        chainId: 46630,
        urls: { apiURL: 'https://explorer.testnet.chain.robinhood.com/api', browserURL: 'https://explorer.testnet.chain.robinhood.com' },
      },
    ],
  },
};
