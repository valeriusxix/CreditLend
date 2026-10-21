// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IInterestRateModel
/// @notice Stateless rate curve queried by CreditLendPool on every accrual.
/// @dev All rates are WAD-scaled (1e18 = 100%). Inputs are in $CREDIT base units (6 decimals).
interface IInterestRateModel {
    /// @return Fraction of lender assets that is currently borrowed, WAD-scaled and capped at 1e18.
    function utilization(uint256 cash, uint256 borrows, uint256 reserves) external pure returns (uint256);

    /// @return Annual borrow rate, WAD-scaled.
    function borrowRatePerYear(uint256 cash, uint256 borrows, uint256 reserves) external view returns (uint256);

    /// @return Per-second borrow rate, WAD-scaled. This is what the pool accrues with.
    function borrowRatePerSecond(uint256 cash, uint256 borrows, uint256 reserves) external view returns (uint256);
}
