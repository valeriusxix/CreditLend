// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IOrbioExchange
/// @notice The read-only subset of the Orbio Exchange (proxy 0x6951ffd32630b05e06f50062aea801625a58ebc0,
///         implementation OrbioExchange, verified on Sourcify) that CreditLend's oracle uses.
/// @dev Facts verified from the source and live state on 2026-10-21 (block 94,159,369):
///      - Asks can only be placed at prices <= 1 USDG per CREDIT (`PriceMath.isValid`).
///      - Buyers pay a fee on top (`feeBps`, 200 = 2% live, hard max 1,000 = 10%). Quotes include it.
///      - `cancel` is immediate, so an ask can be placed, read and cancelled in one transaction:
///        any single quote can be pushed DOWN for free. Our oracle never trusts a single reading.
///      - A quote touches at most `MAX_FILLS` = 64 orders; minimum order size is 5 CREDIT.
///      Field order and enum values below are copied from IExchange.sol.
interface IOrbioExchange {
    enum StopReason {
        BudgetSpent,
        LiquidityExhausted,
        UnitUnaffordable,
        WorkLimit,
        TargetReached // getQuoteForCredit only: the whole requested amount is covered
    }

    struct Quote {
        uint256 creditOut; // CREDIT base units acquired
        uint256 usdgSpent; // USDG base units paid to sellers
        uint256 feeAtoms; // USDG base units charged on top as the buyer fee
        uint256 fills; // orders touched
        StopReason reason;
    }

    /// @notice Cost of buying exactly `creditAtoms` from the book right now, cheapest first.
    function getQuoteForCredit(uint256 creditAtoms, uint256 maxFills) external view returns (Quote memory);

    function credit() external view returns (address);
}
