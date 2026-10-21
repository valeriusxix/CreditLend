// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ICollateralManager
/// @notice Collateral configuration + valuation. Holds NO funds; all custody is in CreditLendPool.
interface ICollateralManager {
    /// @param listed           Asset is known to the market. Assets are never unlisted (that would strand collateral).
    /// @param depositsEnabled  New collateral deposits allowed. Existing collateral keeps working when false.
    /// @param decimals         Token decimals, cached at listing time.
    /// @param ltvBps           Max borrow power per $ of collateral (basis points). 0 = no new borrowing against it.
    /// @param liqThresholdBps  Collateral weight used for the health factor (basis points).
    /// @param liqBonusBps      Extra collateral paid to liquidators on top of the repaid value (basis points).
    /// @param supplyCap        Max total deposits of this asset, in token base units.
    struct AssetConfig {
        bool listed;
        bool depositsEnabled;
        uint8 decimals;
        uint16 ltvBps;
        uint16 liqThresholdBps;
        uint16 liqBonusBps;
        uint256 supplyCap;
    }

    function debtAsset() external view returns (address);

    function getAssetConfig(address asset) external view returns (AssetConfig memory);

    function getListedAssets() external view returns (address[] memory);

    /// @return USD price (WAD) per whole token of a listed collateral asset. Reverts if unavailable.
    function getPrice(address asset) external view returns (uint256);

    /// @return USD price (WAD) per whole $CREDIT used to size liquidation seizures; never above $1 face value.
    function getDebtSettlementPrice() external view returns (uint256);

    /// @return value       Full USD value (WAD) of `amount`.
    /// @return borrowPower `value` weighted by LTV.
    /// @return liqValue    `value` weighted by liquidation threshold.
    function collateralValue(address asset, uint256 amount)
        external
        view
        returns (uint256 value, uint256 borrowPower, uint256 liqValue);
}
