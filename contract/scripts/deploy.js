require('dotenv').config();
const hre = require('hardhat');

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const env = process.env;

  const signer =
    env.SIGNER_ADDRESS ||
    (env.SIGNER_PRIVATE_KEY ? new ethers.Wallet(env.SIGNER_PRIVATE_KEY).address : deployer.address);

  const params = {
    signer,
    threshold: BigInt(env.THRESHOLD_POINTS || '10000'),
    pointsForMax: BigInt(env.POINTS_FOR_MAX || '1000000'),
    minPayout: ethers.parseEther(env.MIN_PAYOUT_ETH || '0.001'),
    maxPayout: ethers.parseEther(env.MAX_PAYOUT_ETH || '0.1'),
    cooldown: BigInt(env.COOLDOWN_SECONDS || '86400'),
  };

  const chainId = (await ethers.provider.getNetwork()).chainId;
  console.log(`network   : ${network.name} (chainId ${chainId})`);
  console.log(`deployer  : ${deployer.address}`);
  console.log(`signer    : ${params.signer}`);
  console.log(`threshold : ${params.threshold} pts -> ${ethers.formatEther(params.minPayout)} ETH`);
  console.log(`max at    : ${params.pointsForMax} pts -> ${ethers.formatEther(params.maxPayout)} ETH`);
  console.log(`cooldown  : ${params.cooldown}s`);

  const factory = await ethers.getContractFactory('NgrbetRewards');
  const contract = await factory.deploy(
    params.signer,
    params.threshold,
    params.pointsForMax,
    params.minPayout,
    params.maxPayout,
    params.cooldown,
  );
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`\nNgrbetRewards deployed at ${address}`);

  const fund = env.FUND_ETH && Number(env.FUND_ETH) > 0 ? ethers.parseEther(env.FUND_ETH) : 0n;
  if (fund > 0n) {
    const tx = await deployer.sendTransaction({ to: address, value: fund });
    await tx.wait();
    console.log(`funded with ${ethers.formatEther(fund)} ETH (tx ${tx.hash})`);
  }

  console.log(
    `\nverify: npx hardhat verify --network ${network.name} ${address} ` +
      `${params.signer} ${params.threshold} ${params.pointsForMax} ${params.minPayout} ${params.maxPayout} ${params.cooldown}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
