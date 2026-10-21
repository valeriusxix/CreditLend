// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title FixedPriceOracle
/// @notice v1 oracle: immutable prices set at deployment, no admin, no external inputs.
/// @dev Intended v1 configuration (decision 2):
///        $CREDIT = $1.00  (face value; the conservative CEILING for a debt asset)
///        USDG    = $1.00  (only collateral in v1; the 70% LTV is the safety margin)
///      Nothing here can be manipulated. Its limitation is that it cannot see a USDG depeg; the
///      mitigation in v1 is the guardian pausing new borrows/collateral, plus the priority-2 oracle
///      (order book TWAP + Uniswap + circuit breakers) swapped in through the timelocked
///      `CollateralManager.setOracle`.
contract FixedPriceOracle is IPriceOracle {
    mapping(address asset => uint256 priceWad) private _prices;

    error LengthMismatch();
    error ZeroPrice();
    error PriceUnavailable(address asset);

    constructor(address[] memory assets, uint256[] memory pricesWad) {
        if (assets.length != pricesWad.length) revert LengthMismatch();
        for (uint256 i; i < assets.length; ++i) {
            if (pricesWad[i] == 0) revert ZeroPrice();
            _prices[assets[i]] = pricesWad[i];
        }
    }

    /// @inheritdoc IPriceOracle
    function getPrice(address asset) external view returns (uint256 priceWad) {
        priceWad = _prices[asset];
        if (priceWad == 0) revert PriceUnavailable(asset);
    }
}
