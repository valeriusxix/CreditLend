// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Chainlink's standard price-feed interface (AggregatorV3Interface subset).
interface IChainlinkAggregator {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title ChainlinkStablecoinOracle
/// @notice Prices ONE stablecoin collateral (USDG in v1) from a Chainlink USD feed, so a depeg reaches
///         the market (AUDIT.md M-3). Replaces the fixed $1 price as `CreditPriceOracle.baseOracle`.
///
///         - Never above $1: a stablecoin trading a little over $1 must not raise anyone's borrowing power.
///         - Fresh answer below $1 (a depeg) is used as is, so borrow limits shrink and positions can be
///           liquidated. Chainlink updates on every 0.5% move, so a depeg shows within minutes.
///         - Stale (older than `maxAge`), zero/negative, future-dated or reverting feed: falls back to
///           $1, exactly the v1 fixed price. An outage is therefore never worse than before, and it can't
///           block liquidations the way a reverting price would. Nobody but Chainlink can make the feed
///           stale. Residual risk: a depeg during a Chainlink outage is not seen (as in v1).
/// @dev    Robinhood Chain has no Chainlink L2 sequencer-uptime feed (checked 2026-10-22), so none is
///         consulted.
contract ChainlinkStablecoinOracle is IPriceOracle {
    uint256 public constant ONE_DOLLAR = 1e18;

    address public immutable asset;
    IChainlinkAggregator public immutable feed;
    /// @notice Older answers are ignored (feed heartbeat plus a margin).
    uint256 public immutable maxAge;
    uint256 internal immutable _scale;

    error ZeroAddress();
    error InvalidParameter();
    error PriceUnavailable(address asset);

    constructor(address asset_, IChainlinkAggregator feed_, uint256 maxAge_) {
        if (asset_ == address(0) || address(feed_) == address(0)) revert ZeroAddress();
        if (maxAge_ == 0) revert InvalidParameter();
        uint8 d = feed_.decimals();
        if (d > 18) revert InvalidParameter();
        asset = asset_;
        feed = feed_;
        maxAge = maxAge_;
        _scale = 10 ** (18 - d);
    }

    /// @inheritdoc IPriceOracle
    function getPrice(address asset_) external view returns (uint256) {
        if (asset_ != asset) revert PriceUnavailable(asset_);
        try feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxAge) {
                return ONE_DOLLAR;
            }
            uint256 price = uint256(answer) * _scale;
            return price > ONE_DOLLAR ? ONE_DOLLAR : price;
        } catch {
            return ONE_DOLLAR;
        }
    }
}
