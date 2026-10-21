// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IPriceOracle
/// @notice Price source consumed by the CollateralManager.
/// @dev Prices are USD per ONE WHOLE token, scaled to 1e18 (WAD), independent of token decimals.
///      Implementations MUST revert rather than return a stale, zero or otherwise untrusted price.
///      The priority-2 oracle (order book TWAP + Uniswap + circuit breakers) will implement this
///      same interface so it can be swapped in via a timelocked `CollateralManager.setOracle`.
interface IPriceOracle {
    function getPrice(address asset) external view returns (uint256 priceWad);
}
