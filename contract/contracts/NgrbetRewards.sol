// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ngrbet rewards
/// @notice Players farm points in the game. Once a player has at least `threshold`
///         points, the backend signer issues an EIP-712 voucher and the player
///         redeems it here for ETH. Payout scales linearly from `minPayout`
///         (at `threshold` points) to `maxPayout` (at `pointsForMax` points).
///         The contract is funded by the owner and pays out of its own balance.
contract NgrbetRewards is Ownable, Pausable, ReentrancyGuard, EIP712 {
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(address player,uint256 points,uint256 nonce,uint256 deadline)");

    /// @notice Backend key that attests a player's points.
    address public signer;
    /// @notice Minimum points required to claim.
    uint256 public threshold;
    /// @notice Points at which the payout reaches `maxPayout`.
    uint256 public pointsForMax;
    /// @notice Payout at exactly `threshold` points (wei).
    uint256 public minPayout;
    /// @notice Payout cap (wei).
    uint256 public maxPayout;
    /// @notice Minimum seconds between two claims by the same wallet.
    uint256 public cooldown;

    mapping(address => uint256) public nonces;
    mapping(address => uint256) public lastClaimAt;
    mapping(address => uint256) public totalClaimed;

    event Funded(address indexed from, uint256 amount);
    event Claimed(address indexed player, uint256 points, uint256 amount, uint256 nonce);
    event SignerUpdated(address indexed signer);
    event PayoutsUpdated(uint256 threshold, uint256 pointsForMax, uint256 minPayout, uint256 maxPayout);
    event CooldownUpdated(uint256 cooldown);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error InvalidConfig();
    error Expired(uint256 deadline);
    error NotEnoughPoints(uint256 points, uint256 threshold);
    error CooldownActive(uint256 availableAt);
    error BadSignature();
    error InsufficientFunds(uint256 needed, uint256 available);
    error TransferFailed();

    constructor(
        address signer_,
        uint256 threshold_,
        uint256 pointsForMax_,
        uint256 minPayout_,
        uint256 maxPayout_,
        uint256 cooldown_
    ) Ownable(msg.sender) EIP712("ngrbet rewards", "1") {
        _setSigner(signer_);
        _setPayouts(threshold_, pointsForMax_, minPayout_, maxPayout_);
        cooldown = cooldown_;
        emit CooldownUpdated(cooldown_);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ views

    /// @notice ETH (wei) paid for a given number of points. 0 below threshold.
    function payoutFor(uint256 points) public view returns (uint256) {
        if (points < threshold) return 0;
        if (points >= pointsForMax) return maxPayout;
        return minPayout + ((maxPayout - minPayout) * (points - threshold)) / (pointsForMax - threshold);
    }

    /// @notice EIP-712 digest the signer must sign to authorise a claim.
    function claimDigest(address player, uint256 points, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, player, points, nonce, deadline)));
    }

    /// @notice Timestamp from which `player` may claim again.
    function nextClaimAt(address player) external view returns (uint256) {
        return lastClaimAt[player] + cooldown;
    }

    // ------------------------------------------------------------------ claim

    /// @notice Redeem a signed voucher for ETH.
    /// @param points    Points attested by the signer for msg.sender.
    /// @param deadline  Unix time after which the voucher is void.
    /// @param signature Signer EIP-712 signature over (msg.sender, points, nonces[msg.sender], deadline).
    function claim(uint256 points, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
        nonReentrant
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (points < threshold) revert NotEnoughPoints(points, threshold);
        uint256 availableAt = lastClaimAt[msg.sender] + cooldown;
        if (lastClaimAt[msg.sender] != 0 && block.timestamp < availableAt) revert CooldownActive(availableAt);

        uint256 nonce = nonces[msg.sender];
        bytes32 digest = claimDigest(msg.sender, points, nonce, deadline);
        if (ECDSA.recover(digest, signature) != signer) revert BadSignature();

        uint256 amount = payoutFor(points);
        uint256 available = address(this).balance;
        if (amount > available) revert InsufficientFunds(amount, available);

        nonces[msg.sender] = nonce + 1;
        lastClaimAt[msg.sender] = block.timestamp;
        totalClaimed[msg.sender] += amount;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Claimed(msg.sender, points, amount, nonce);
    }

    // ------------------------------------------------------------------ admin

    function setSigner(address signer_) external onlyOwner {
        _setSigner(signer_);
    }

    function setPayouts(uint256 threshold_, uint256 pointsForMax_, uint256 minPayout_, uint256 maxPayout_)
        external
        onlyOwner
    {
        _setPayouts(threshold_, pointsForMax_, minPayout_, maxPayout_);
    }

    function setCooldown(uint256 cooldown_) external onlyOwner {
        cooldown = cooldown_;
        emit CooldownUpdated(cooldown_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Pull ETH back out of the reward pool.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    // ------------------------------------------------------------------ internal

    function _setSigner(address signer_) internal {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerUpdated(signer_);
    }

    function _setPayouts(uint256 threshold_, uint256 pointsForMax_, uint256 minPayout_, uint256 maxPayout_)
        internal
    {
        if (threshold_ == 0 || pointsForMax_ <= threshold_) revert InvalidConfig();
        if (minPayout_ == 0 || maxPayout_ < minPayout_) revert InvalidConfig();
        threshold = threshold_;
        pointsForMax = pointsForMax_;
        minPayout = minPayout_;
        maxPayout = maxPayout_;
        emit PayoutsUpdated(threshold_, pointsForMax_, minPayout_, maxPayout_);
    }
}
