// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./BaseTest.sol";
import {CreditPriceOracle} from "../src/oracle/CreditPriceOracle.sol";
import {IOrbioExchange} from "../src/interfaces/IOrbioExchange.sol";
import {MockOrbioExchange} from "./mocks/OracleMocks.sol";

contract CreditPriceOracleTest is BaseTest {
    uint256 constant SIZE = 5_000e6;

    MockOrbioExchange book;
    CreditPriceOracle po;

    function setUp() public override {
        super.setUp();
        book = new MockOrbioExchange(address(credit));
        po = new CreditPriceOracle(
            book,
            oracle, // base oracle prices USDG / ORBIO
            SIZE,
            5 minutes,
            1 hours,
            2 hours,
            2_500, // 25% divergence
            200 // 2% per hour max drop
        );
    }

    // ---------------------------------------------------------------- helpers

    function _read(uint256 priceWad) internal returns (CreditPriceOracle.ReadingStatus s, uint256 recorded) {
        book.setPrice(SIZE, priceWad, 0);
        (s, recorded) = po.update();
    }

    /// Reads `priceWad` every 5 minutes for `hours_` hours.
    function _readFor(uint256 priceWad, uint256 hours_) internal {
        for (uint256 i; i < hours_ * 12; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            _read(priceWad);
        }
    }

    /// Brings the oracle to a steady $0.55 with a full hour of history at that price.
    function _converge() internal {
        _read(0.55e18);
        _readFor(0.55e18, 40);
        assertEq(po.getPrice(address(credit)), 0.55e18);
    }

    // ---------------------------------------------------------------- basics

    function test_noReadings_returnsFaceValue() public view {
        assertEq(po.getPrice(address(credit)), 1e18);
        assertFalse(po.isFresh());
    }

    function test_otherAssets_passThroughToBaseOracle() public {
        assertEq(po.getPrice(address(usdg)), 1e18);
        assertEq(po.getPrice(address(orbio)), 0.5e18);
        vm.expectRevert("no price");
        po.getPrice(makeAddr("unknown"));
    }

    function test_warmUp_startsAtFaceValueAndFallsAtMost2PercentPerHour() public {
        (CreditPriceOracle.ReadingStatus s, uint256 recorded) = _read(0.55e18);
        assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.Clamped));
        assertEq(recorded, 0.98e18, "first reading: $1 less one hour's 2%");

        _readFor(0.55e18, 10);
        uint256 p = po.getPrice(address(credit));
        assertGt(p, 0.55e18, "still warming up after 10h");
        assertLt(p, 0.98e18);

        _readFor(0.55e18, 30);
        assertEq(po.getPrice(address(credit)), 0.55e18, "reaches market after ~30h");
    }

    function test_reading_includesOrbioBuyerFee() public {
        book.setPrice(SIZE, 0.5e18, 200); // $0.50 + 2% fee
        po.update();
        assertEq(po.lastRawPrice(), 0.51e18);
    }

    function test_reading_cappedAtFaceValue() public {
        book.setPrice(SIZE, 1e18, 200); // $1.00 + 2% fee = $1.02 all-in
        (, uint256 recorded) = po.update();
        assertEq(po.lastRawPrice(), 1e18);
        assertEq(recorded, 1e18);
    }

    // ---------------------------------------------------------------- circuit breakers

    function test_breaker_tooSoon() public {
        _read(0.55e18);
        vm.warp(block.timestamp + 5 minutes - 1);
        book.setPrice(SIZE, 0.55e18, 0);
        vm.expectRevert(abi.encodeWithSelector(CreditPriceOracle.TooSoon.selector, block.timestamp + 1));
        po.update();
    }

    function test_breaker_incompleteQuote_rejected() public {
        IOrbioExchange.StopReason[3] memory bad = [
            IOrbioExchange.StopReason.LiquidityExhausted,
            IOrbioExchange.StopReason.WorkLimit,
            IOrbioExchange.StopReason.BudgetSpent
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            book.setRawQuote(IOrbioExchange.Quote(SIZE / 2, 1_000e6, 0, 64, bad[i]));
            (CreditPriceOracle.ReadingStatus s,) = po.update();
            assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.RejectedIncomplete));
        }
        // "TargetReached" but short of the size is also rejected.
        vm.warp(block.timestamp + 5 minutes);
        book.setRawQuote(IOrbioExchange.Quote(SIZE - 1, 1_000e6, 0, 10, IOrbioExchange.StopReason.TargetReached));
        (CreditPriceOracle.ReadingStatus s2,) = po.update();
        assertEq(uint8(s2), uint8(CreditPriceOracle.ReadingStatus.RejectedIncomplete));

        (uint256 ts,) = po.latestObservation();
        assertEq(ts, 0, "nothing recorded");
        assertEq(po.getPrice(address(credit)), 1e18);
    }

    function test_breaker_divergentSpikeDown_rejectedUntilConfirmed() public {
        _converge();

        vm.warp(block.timestamp + 5 minutes);
        (CreditPriceOracle.ReadingStatus s,) = _read(0.30e18); // -45%: e.g. fake asks in one tx
        assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.RejectedDivergent));
        assertEq(po.getPrice(address(credit)), 0.55e18, "price unchanged");

        // The same level again 5 minutes later is a confirmed move, but still only falls slowly.
        vm.warp(block.timestamp + 5 minutes);
        (s,) = _read(0.30e18);
        assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.Clamped));
        assertGt(po.getPrice(address(credit)), 0.54e18);
    }

    function test_breaker_divergentSpikeUp_rejectedThenAcceptedWhenConfirmed() public {
        _converge();

        vm.warp(block.timestamp + 5 minutes);
        (CreditPriceOracle.ReadingStatus s,) = _read(0.80e18); // +45%
        assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.RejectedDivergent));

        vm.warp(block.timestamp + 5 minutes);
        uint256 recorded;
        (s, recorded) = _read(0.80e18);
        assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.Accepted), "rises are not speed-limited");
        assertEq(recorded, 0.80e18);
    }

    function test_breaker_speedLimit_dropClampedTo2PercentPerHour() public {
        _converge();
        _readFor(0.50e18, 1); // -9%: within the divergence band, but faster than 2%/h

        (, uint256 latest) = po.latestObservation();
        assertApproxEqRel(latest, 0.539e18, 0.001e18, "one hour of 2%/h from $0.55");
        assertGe(latest, (uint256(0.55e18) * 98) / 100);
    }

    // Replaced (with the owner's approval, 2026-10-21) the earlier "restarts from $1" test: after an
    // outage the oracle now resumes from the last good price instead of a 30-hour warm-up from $1.
    function test_breaker_stale_fallsBackToFaceValue_thenResumesFromLastGoodPrice() public {
        _converge();
        vm.warp(block.timestamp + 2 hours + 1);
        assertFalse(po.isFresh());
        assertEq(po.getPrice(address(credit)), 1e18, "stale -> $1");

        (CreditPriceOracle.ReadingStatus s, uint256 recorded) = _read(0.55e18);
        assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.Accepted));
        assertEq(recorded, 0.55e18, "resumes at the last good price");
        assertEq(po.getPrice(address(credit)), 0.55e18, "old history cleared; no $1 warm-up");
    }

    /// Market fell during the outage: the move must be confirmed, then it is still speed-limited.
    function test_breaker_stale_marketFellDuringOutage_fallsAtMost2Percent() public {
        _converge();
        vm.warp(block.timestamp + 6 hours);
        assertEq(po.getPrice(address(credit)), 1e18);

        (CreditPriceOracle.ReadingStatus s,) = _read(0.40e18); // -27% vs the last reading
        assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.RejectedDivergent));
        assertEq(po.getPrice(address(credit)), 1e18, "still stale until a reading is recorded");

        vm.warp(block.timestamp + 5 minutes);
        uint256 recorded;
        (s, recorded) = _read(0.40e18);
        assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.Clamped));
        assertEq(recorded, 0.539e18, "$0.55 less at most 2%");
    }

    /// Market rose during the outage: once confirmed, the higher price is used at once.
    function test_breaker_stale_marketRoseDuringOutage_adoptedWhenConfirmed() public {
        _converge();
        vm.warp(block.timestamp + 6 hours);
        _read(0.70e18); // +27%: rejected, needs confirmation
        vm.warp(block.timestamp + 5 minutes);
        (CreditPriceOracle.ReadingStatus s, uint256 recorded) = _read(0.70e18);
        assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.Accepted));
        assertEq(recorded, 0.70e18);
        assertEq(po.getPrice(address(credit)), 0.70e18);
    }

    function test_exchangeDown_updateReverts_priceKeepsWorking() public {
        _converge();
        book.setReverts(true);
        vm.warp(block.timestamp + 5 minutes);
        vm.expectRevert("exchange down");
        po.update();
        assertEq(po.getPrice(address(credit)), 0.55e18);
    }

    // ---------------------------------------------------------------- averaging

    function test_twap_isTimeWeighted() public {
        _converge();
        vm.warp(block.timestamp + 5 minutes);
        _read(0.65e18); // +18%: within the band, rises unlimited
        vm.warp(block.timestamp + 30 minutes);
        // Last hour: 30 min at $0.55, 30 min at $0.65.
        assertEq(po.getPrice(address(credit)), 0.60e18);
    }

    // ---------------------------------------------------------------- integration with the pool

    /// Liquidations use the stored price only: moving the live book changes nothing until a
    /// (rate-limited) reading is taken, so the book can't be gamed within one liquidation.
    function test_liquidation_usesStoredPrice_notLiveBook() public {
        _converge();
        vm.prank(owner);
        cm.setOracle(po);

        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 700 * ONE_CREDIT);
        oracle.setPrice(address(usdg), 0.8e18); // HF 0.914 -> full liquidation

        book.setPrice(SIZE, 0.10e18, 0); // someone dumps the live book; no reading taken
        assertEq(cm.getDebtSettlementPrice(), 0.55e18);

        (, uint256 seized) = _liquidate(borrower, address(usdg), 700 * ONE_CREDIT);
        assertEq(seized, 505_312_500); // 700 * $0.55 * 1.05 / $0.80
    }

    // ---------------------------------------------------------------- fuzz

    /// Whatever the book does, the price stays in (0, $1] and never falls faster than 2%/hour.
    function testFuzz_priceBoundedAndDropRateLimited(uint256[24] memory prices, uint256[24] memory gaps) public {
        uint256 prevRecorded;
        uint256 prevTime;
        for (uint256 i; i < prices.length; ++i) {
            vm.warp(block.timestamp + bound(gaps[i], 5 minutes, 3 hours));
            uint256 p = bound(prices[i], 0.01e18, 1.5e18);
            book.setPrice(SIZE, p, 0);
            bool freshBefore = po.isFresh();
            (CreditPriceOracle.ReadingStatus s, uint256 recorded) = po.update();

            uint256 price = po.getPrice(address(credit));
            assertGt(price, 0);
            assertLe(price, 1e18);

            if (s == CreditPriceOracle.ReadingStatus.Accepted || s == CreditPriceOracle.ReadingStatus.Clamped) {
                assertLe(recorded, 1e18);
                if (freshBefore && prevRecorded != 0) {
                    uint256 elapsed = block.timestamp - prevTime;
                    if (elapsed > 1 hours) elapsed = 1 hours;
                    uint256 minAllowed = (prevRecorded * (10_000 * 3600 - 200 * elapsed)) / (10_000 * 3600);
                    assertGe(recorded, minAllowed, "fell faster than 2%/h");
                }
                prevRecorded = recorded;
                prevTime = block.timestamp;
            }
        }
    }
}
