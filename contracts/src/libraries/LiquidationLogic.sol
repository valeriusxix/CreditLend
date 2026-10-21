// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title LiquidationLogic
/// @notice Pure, deterministic risk math shared by CreditLendPool. Holds no state and no funds.
/// @dev Units:
///      - USD values and prices are WAD (1e18 = $1). Prices are per ONE WHOLE token.
///      - Token amounts are in each token's base units.
///      - Rounding always favors the protocol (lenders): debt and liquidator payments round UP,
///        collateral value and collateral paid out round DOWN.
library LiquidationLogic {
    using Math for uint256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @notice Share of a position's debt that one liquidation may repay while HF is only mildly < 1.
    uint256 internal constant CLOSE_FACTOR_BPS = 5_000;

    /// @notice Below this health factor the whole debt may be repaid in a single liquidation.
    uint256 internal constant FULL_LIQUIDATION_HF = 0.95e18;

    /// @notice Health factor = liquidation-weighted collateral value / debt value.
    /// @return WAD-scaled HF, or type(uint256).max when there is no debt.
    function healthFactor(uint256 liqCollateralValue, uint256 debtValue) internal pure returns (uint256) {
        if (debtValue == 0) return type(uint256).max;
        return liqCollateralValue.mulDiv(WAD, debtValue);
    }

    /// @notice Converts a token amount to a WAD USD value.
    function toValue(uint256 amount, uint256 priceWad, uint8 decimals, Math.Rounding rounding)
        internal
        pure
        returns (uint256)
    {
        return amount.mulDiv(priceWad, 10 ** decimals, rounding);
    }

    /// @notice Converts a WAD USD value to a token amount.
    function toAmount(uint256 value, uint256 priceWad, uint8 decimals, Math.Rounding rounding)
        internal
        pure
        returns (uint256)
    {
        return value.mulDiv(10 ** decimals, priceWad, rounding);
    }

    /// @notice Maximum debt a liquidator may repay in one call.
    /// @param debt       Borrower's current debt (debt-asset base units).
    /// @param hf         Borrower's current health factor (WAD).
    /// @param dustDebt   Positions at or below this debt can always be closed in full, so no
    ///                   unliquidatable dust is left behind.
    function maxRepayable(uint256 debt, uint256 hf, uint256 dustDebt) internal pure returns (uint256) {
        if (hf >= WAD) return 0;
        if (hf < FULL_LIQUIDATION_HF || debt <= dustDebt) return debt;
        return debt.mulDiv(CLOSE_FACTOR_BPS, BPS);
    }

    struct SeizeParams {
        uint256 repayAmount; // debt the liquidator wants to repay (already capped by maxRepayable)
        uint256 debtPrice; // settlement price of the debt asset (WAD)
        uint8 debtDecimals;
        uint256 collateralPrice; // price of the seized collateral (WAD)
        uint8 collateralDecimals;
        uint256 bonusBps; // liquidation bonus
        uint256 availableCollateral; // borrower's balance of the seized asset
    }

    /// @notice Sizes a liquidation: collateral seized = repaid value * (1 + bonus) / collateral price.
    /// @dev If the borrower does not hold enough of the chosen collateral, all of it is seized and the
    ///      repayment is scaled down to what that collateral fairly pays for (rounded UP, so the
    ///      liquidator never underpays).
    /// @return repaid  Debt-asset amount the liquidator must pay.
    /// @return seized  Collateral amount transferred to the liquidator.
    function computeSeize(SeizeParams memory p) internal pure returns (uint256 repaid, uint256 seized) {
        uint256 repayValue = toValue(p.repayAmount, p.debtPrice, p.debtDecimals, Math.Rounding.Floor);
        uint256 seizeValue = repayValue.mulDiv(BPS + p.bonusBps, BPS);
        seized = toAmount(seizeValue, p.collateralPrice, p.collateralDecimals, Math.Rounding.Floor);

        if (seized <= p.availableCollateral) {
            return (p.repayAmount, seized);
        }

        seized = p.availableCollateral;
        uint256 availableValue = toValue(seized, p.collateralPrice, p.collateralDecimals, Math.Rounding.Ceil);
        uint256 fairRepayValue = availableValue.mulDiv(BPS, BPS + p.bonusBps, Math.Rounding.Ceil);
        repaid = toAmount(fairRepayValue, p.debtPrice, p.debtDecimals, Math.Rounding.Ceil);
        if (repaid > p.repayAmount) repaid = p.repayAmount;
    }
}
