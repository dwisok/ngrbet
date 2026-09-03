const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const THRESHOLD = 10_000n;
const POINTS_FOR_MAX = 1_000_000n;
const MIN = ethers.parseEther('0.001');
const MAX = ethers.parseEther('0.1');
const COOLDOWN = 86_400n;

describe('NgrbetRewards', () => {
  let owner, signer, player, other, rewards;

  async function voucher(who, points, deadline, by = signer, nonce) {
    if (nonce === undefined) nonce = await rewards.nonces(who.address);
    const domain = {
      name: 'ngrbet rewards',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await rewards.getAddress(),
    };
    const types = {
      Claim: [
        { name: 'player', type: 'address' },
        { name: 'points', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    return by.signTypedData(domain, types, { player: who.address, points, nonce, deadline });
  }

  beforeEach(async () => {
    [owner, signer, player, other] = await ethers.getSigners();
    rewards = await (await ethers.getContractFactory('NgrbetRewards')).deploy(
      signer.address, THRESHOLD, POINTS_FOR_MAX, MIN, MAX, COOLDOWN,
    );
    await owner.sendTransaction({ to: await rewards.getAddress(), value: ethers.parseEther('1') });
  });

  describe('payoutFor', () => {
    it('is 0 below threshold', async () => {
      expect(await rewards.payoutFor(THRESHOLD - 1n)).to.equal(0n);
    });
    it('is min at threshold and max at pointsForMax (and above)', async () => {
      expect(await rewards.payoutFor(THRESHOLD)).to.equal(MIN);
      expect(await rewards.payoutFor(POINTS_FOR_MAX)).to.equal(MAX);
      expect(await rewards.payoutFor(POINTS_FOR_MAX * 10n)).to.equal(MAX);
    });
    it('interpolates linearly in between', async () => {
      const mid = THRESHOLD + (POINTS_FOR_MAX - THRESHOLD) / 2n;
      expect(await rewards.payoutFor(mid)).to.equal(MIN + (MAX - MIN) / 2n);
    });
  });

  describe('claim', () => {
    it('pays out with a valid voucher and bumps nonce', async () => {
      const deadline = (await time.latest()) + 3600;
      const sig = await voucher(player, THRESHOLD, deadline);
      await expect(rewards.connect(player).claim(THRESHOLD, deadline, sig))
        .to.changeEtherBalances([player, rewards], [MIN, -MIN]);
      expect(await rewards.nonces(player.address)).to.equal(1n);
      expect(await rewards.totalClaimed(player.address)).to.equal(MIN);
    });

    it('emits Claimed with the capped amount', async () => {
      const deadline = (await time.latest()) + 3600;
      const sig = await voucher(player, POINTS_FOR_MAX, deadline);
      await expect(rewards.connect(player).claim(POINTS_FOR_MAX, deadline, sig))
        .to.emit(rewards, 'Claimed')
        .withArgs(player.address, POINTS_FOR_MAX, MAX, 0n);
    });

    it('rejects a voucher replayed twice', async () => {
      const deadline = (await time.latest()) + 2 * Number(COOLDOWN);
      const sig = await voucher(player, THRESHOLD, deadline);
      await rewards.connect(player).claim(THRESHOLD, deadline, sig);
      await time.increase(Number(COOLDOWN) + 1);
      await expect(rewards.connect(player).claim(THRESHOLD, deadline, sig))
        .to.be.revertedWithCustomError(rewards, 'BadSignature');
    });

    it('rejects a voucher used by another wallet', async () => {
      const deadline = (await time.latest()) + 3600;
      const sig = await voucher(player, THRESHOLD, deadline);
      await expect(rewards.connect(other).claim(THRESHOLD, deadline, sig))
        .to.be.revertedWithCustomError(rewards, 'BadSignature');
    });

    it('rejects a voucher signed by a non-signer', async () => {
      const deadline = (await time.latest()) + 3600;
      const sig = await voucher(player, THRESHOLD, deadline, other);
      await expect(rewards.connect(player).claim(THRESHOLD, deadline, sig))
        .to.be.revertedWithCustomError(rewards, 'BadSignature');
    });

    it('rejects tampered points', async () => {
      const deadline = (await time.latest()) + 3600;
      const sig = await voucher(player, THRESHOLD, deadline);
      await expect(rewards.connect(player).claim(POINTS_FOR_MAX, deadline, sig))
        .to.be.revertedWithCustomError(rewards, 'BadSignature');
    });

    it('rejects an expired voucher', async () => {
      const deadline = (await time.latest()) - 1;
      const sig = await voucher(player, THRESHOLD, deadline);
      await expect(rewards.connect(player).claim(THRESHOLD, deadline, sig))
        .to.be.revertedWithCustomError(rewards, 'Expired');
    });

    it('rejects below threshold', async () => {
      const deadline = (await time.latest()) + 3600;
      const sig = await voucher(player, THRESHOLD - 1n, deadline);
      await expect(rewards.connect(player).claim(THRESHOLD - 1n, deadline, sig))
        .to.be.revertedWithCustomError(rewards, 'NotEnoughPoints');
    });

    it('enforces the cooldown', async () => {
      let deadline = (await time.latest()) + 3600;
      await rewards.connect(player).claim(THRESHOLD, deadline, await voucher(player, THRESHOLD, deadline));
      deadline = (await time.latest()) + 3600;
      await expect(
        rewards.connect(player).claim(THRESHOLD, deadline, await voucher(player, THRESHOLD, deadline)),
      ).to.be.revertedWithCustomError(rewards, 'CooldownActive');
      await time.increase(Number(COOLDOWN));
      deadline = (await time.latest()) + 3600;
      await expect(
        rewards.connect(player).claim(THRESHOLD, deadline, await voucher(player, THRESHOLD, deadline)),
      ).to.changeEtherBalance(player, MIN);
    });

    it('reverts when the pool is short', async () => {
      await rewards.withdraw(owner.address, ethers.parseEther('1'));
      const deadline = (await time.latest()) + 3600;
      const sig = await voucher(player, THRESHOLD, deadline);
      await expect(rewards.connect(player).claim(THRESHOLD, deadline, sig))
        .to.be.revertedWithCustomError(rewards, 'InsufficientFunds');
    });

    it('is blocked while paused', async () => {
      await rewards.pause();
      const deadline = (await time.latest()) + 3600;
      const sig = await voucher(player, THRESHOLD, deadline);
      await expect(rewards.connect(player).claim(THRESHOLD, deadline, sig))
        .to.be.revertedWithCustomError(rewards, 'EnforcedPause');
    });
  });

  describe('admin', () => {
    it('only owner can change config or withdraw', async () => {
      await expect(rewards.connect(player).setSigner(player.address))
        .to.be.revertedWithCustomError(rewards, 'OwnableUnauthorizedAccount');
      await expect(rewards.connect(player).withdraw(player.address, 1n))
        .to.be.revertedWithCustomError(rewards, 'OwnableUnauthorizedAccount');
    });
    it('rejects invalid payout config', async () => {
      await expect(rewards.setPayouts(THRESHOLD, THRESHOLD, MIN, MAX))
        .to.be.revertedWithCustomError(rewards, 'InvalidConfig');
      await expect(rewards.setPayouts(THRESHOLD, POINTS_FOR_MAX, MAX, MIN))
        .to.be.revertedWithCustomError(rewards, 'InvalidConfig');
    });
    it('owner can withdraw', async () => {
      await expect(rewards.withdraw(owner.address, ethers.parseEther('0.5')))
        .to.changeEtherBalance(owner, ethers.parseEther('0.5'));
    });
    it('accepts funding via receive', async () => {
      await expect(owner.sendTransaction({ to: await rewards.getAddress(), value: 1n }))
        .to.emit(rewards, 'Funded')
        .withArgs(owner.address, 1n);
    });
  });
});
