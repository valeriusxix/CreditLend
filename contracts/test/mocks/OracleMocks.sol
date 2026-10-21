// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOrbioExchange} from "../../src/interfaces/IOrbioExchange.sol";

/// @notice Stand-in for the Orbio Exchange whose quote tests can set directly.
contract MockOrbioExchange is IOrbioExchange {
    address public immutable credit;
    Quote private _quote;
    bool public reverts;

    constructor(address credit_) {
        credit = credit_;
    }

    /// @notice Book where `creditAtoms` costs `priceWad` per CREDIT plus `feeBps` on top.
    function setPrice(uint256 creditAtoms, uint256 priceWad, uint256 feeBps) external {
        uint256 spent = (creditAtoms * priceWad) / 1e18;
        _quote = Quote({
            creditOut: creditAtoms,
            usdgSpent: spent,
            feeAtoms: (spent * feeBps) / 10_000,
            fills: 10,
            reason: StopReason.TargetReached
        });
    }

    function setRawQuote(Quote memory q) external {
        _quote = q;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function getQuoteForCredit(uint256, uint256) external view returns (Quote memory) {
        require(!reverts, "exchange down");
        return _quote;
    }
}
