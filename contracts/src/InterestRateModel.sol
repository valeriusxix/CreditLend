// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IInterestRateModel} from "./interfaces/IInterestRateModel.sol";

/// @title KinkedInterestRateModel
/// @notice Utilization-based borrow rate with a kink (AGENT.md §4.1, §5):
///
///   util <= kink : rate = base + slope1 * util / kink
///   util >  kink : rate = base + slope1 + slope2 * (util - kink) / (1 - kink)
///
/// @dev Parameters are IMMUTABLE. Changing rates means deploying a new model and pointing the pool
///      at it via a timelocked `CreditLendPool.setInterestRateModel`, which accrues interest at the
///      old rate first, so a change is never applied retroactively. The agent's bounded rate-update
///      path (build priority 3) will route through that same pool function.
contract KinkedInterestRateModel is IInterestRateModel {
    using Math for uint256;

    uint256 internal constant WAD = 1e18;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// @notice Hard ceiling on the maximum rate this curve can produce (1000% APR).
    uint256 public constant MAX_BORROW_RATE_PER_YEAR = 10e18;

    uint256 public immutable baseRatePerYear;
    uint256 public immutable slope1PerYear;
    uint256 public immutable slope2PerYear;
    uint256 public immutable kink;

    error InvalidKink();
    error RateTooHigh();

    constructor(uint256 baseRatePerYear_, uint256 slope1PerYear_, uint256 slope2PerYear_, uint256 kink_) {
        if (kink_ == 0 || kink_ >= WAD) revert InvalidKink();
        if (baseRatePerYear_ + slope1PerYear_ + slope2PerYear_ > MAX_BORROW_RATE_PER_YEAR) revert RateTooHigh();
        baseRatePerYear = baseRatePerYear_;
        slope1PerYear = slope1PerYear_;
        slope2PerYear = slope2PerYear_;
        kink = kink_;
    }

    /// @inheritdoc IInterestRateModel
    /// @dev Lender assets = cash + borrows - reserves. Capped at 100% (it can exceed that briefly if
    ///      lenders withdraw cash that backs reserves).
    function utilization(uint256 cash, uint256 borrows, uint256 reserves) public pure returns (uint256) {
        if (borrows == 0) return 0;
        uint256 gross = cash + borrows;
        if (gross <= reserves) return WAD;
        uint256 u = borrows.mulDiv(WAD, gross - reserves);
        return u > WAD ? WAD : u;
    }

    /// @inheritdoc IInterestRateModel
    function borrowRatePerYear(uint256 cash, uint256 borrows, uint256 reserves) public view returns (uint256) {
        uint256 u = utilization(cash, borrows, reserves);
        if (u <= kink) {
            return baseRatePerYear + slope1PerYear.mulDiv(u, kink);
        }
        return baseRatePerYear + slope1PerYear + slope2PerYear.mulDiv(u - kink, WAD - kink);
    }

    /// @inheritdoc IInterestRateModel
    function borrowRatePerSecond(uint256 cash, uint256 borrows, uint256 reserves) external view returns (uint256) {
        return borrowRatePerYear(cash, borrows, reserves) / SECONDS_PER_YEAR;
    }
}
