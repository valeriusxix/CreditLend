// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {CreditPriceOracle} from "../../src/oracle/CreditPriceOracle.sol";
import {FixedPriceOracle} from "../../src/oracle/FixedPriceOracle.sol";
import {IOrbioExchange} from "../../src/interfaces/IOrbioExchange.sol";

/// Reads the LIVE Orbio Exchange on Robinhood Chain through the oracle's own interface, to catch
/// any mismatch between our IOrbioExchange and the deployed contract. Needs network access.
contract OrbioExchangeForkTest is Test {
    address constant EXCHANGE = 0x6951fFd32630b05e06F50062AEA801625A58eBC0;
    address constant CREDIT = 0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function test_fork_liveExchangeQuoteDecodesAndPrices() public {
        vm.createSelectFork("robinhood");

        IOrbioExchange ex = IOrbioExchange(EXCHANGE);
        assertEq(ex.credit(), CREDIT);

        IOrbioExchange.Quote memory q = ex.getQuoteForCredit(5_000e6, 64);
        console.log("live quote: creditOut", q.creditOut, "usdgSpent", q.usdgSpent);
        console.log("            fee", q.feeAtoms, "fills", q.fills);
        assertLe(q.fills, 64);

        address[] memory assets = new address[](1);
        assets[0] = USDG;
        uint256[] memory prices = new uint256[](1);
        prices[0] = 1e18;
        CreditPriceOracle po = new CreditPriceOracle(
            ex, new FixedPriceOracle(assets, prices), 5_000e6, 5 minutes, 1 hours, 2 hours, 2_500, 200
        );

        (CreditPriceOracle.ReadingStatus s, uint256 recorded) = po.update();
        console.log("raw all-in price (WAD)", po.lastRawPrice());
        if (q.reason == IOrbioExchange.StopReason.TargetReached) {
            assertGt(po.lastRawPrice(), 0.05e18, "implausibly low");
            assertLe(po.lastRawPrice(), 1e18, "above face value");
            // First reading warms up from $1.
            assertEq(recorded, 0.98e18);
            assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.Clamped));
        } else {
            assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.RejectedIncomplete));
        }
        assertEq(po.getPrice(USDG), 1e18);
    }
}
