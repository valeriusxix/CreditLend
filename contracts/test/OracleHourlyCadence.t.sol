// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./BaseTest.sol";
import {CreditPriceOracle} from "../src/oracle/CreditPriceOracle.sol";
import {MockOrbioExchange} from "./mocks/OracleMocks.sol";

/// The agent reads the oracle hourly while the market is calm, so readings can be ~61 minutes apart:
/// longer than the 1-hour averaging window. The price must then hold at the last reading, stay fresh,
/// and liquidations must keep working between readings.
contract OracleHourlyCadenceTest is BaseTest {
    uint256 constant SIZE = 5_000e6;
    uint256 constant GAP = 61 minutes; // hourly schedule + up to a minute of keeper tick delay

    MockOrbioExchange book;
    CreditPriceOracle po;

    function setUp() public override {
        super.setUp();
        book = new MockOrbioExchange(address(credit));
        po = new CreditPriceOracle(book, oracle, SIZE, 5 minutes, 1 hours, 2 hours, 2_500, 200);
        vm.prank(owner);
        cm.setOracle(po);

        // Converge to $0.55 with 5-minute readings (as after deployment warm-up).
        for (uint256 i; i < 40 * 12; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            _read(0.55e18);
        }
        assertEq(po.getPrice(address(credit)), 0.55e18);
    }

    function _read(uint256 priceWad) internal returns (CreditPriceOracle.ReadingStatus s, uint256 recorded) {
        book.setPrice(SIZE, priceWad, 0);
        (s, recorded) = po.update();
    }

    function test_hourlyReadings_priceHoldsAndStaysFresh() public {
        for (uint256 i; i < 6; ++i) {
            vm.warp(block.timestamp + GAP - 1); // just before the next reading
            assertTrue(po.isFresh());
            assertEq(po.getPrice(address(credit)), 0.55e18, "holds the last reading");
            assertEq(cm.getDebtSettlementPrice(), 0.55e18);
            vm.warp(block.timestamp + 1);
            _read(0.55e18);
        }
    }

    function test_hourlyReadings_followAFallUnderTheSpeedLimit() public {
        vm.warp(block.timestamp + GAP);
        (CreditPriceOracle.ReadingStatus s, uint256 recorded) = _read(0.50e18);
        assertEq(uint8(s), uint8(CreditPriceOracle.ReadingStatus.Clamped));
        assertEq(recorded, 0.539e18, "at most 2% down per hour");

        vm.warp(block.timestamp + GAP - 1);
        assertEq(po.getPrice(address(credit)), 0.539e18, "a full window later: exactly the last reading");
    }

    function test_hourlyReadings_missedReadingStillFreshUntilTwoHours() public {
        vm.warp(block.timestamp + 2 hours);
        assertTrue(po.isFresh());
        assertEq(po.getPrice(address(credit)), 0.55e18);
        vm.warp(block.timestamp + 1);
        assertFalse(po.isFresh(), "two missed hours: falls back to $1");
        assertEq(po.getPrice(address(credit)), 1e18);
    }

    function test_liquidationBetweenHourlyReadings() public {
        _lend(lender, 50_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 10_000 * ONE_USDG);
        _borrow(borrower, 7_000 * ONE_CREDIT);

        vm.warp(block.timestamp + GAP - 1); // no new reading yet
        oracle.setPrice(address(usdg), 0.8e18); // HF = 10,000 * 0.8 * 0.8 / 7,000 ~ 0.91
        assertLt(_healthFactor(borrower), 1e18);

        uint256 debt = pool.debtOf(borrower);
        (uint256 repaid, uint256 seized) = _liquidate(borrower, address(usdg), debt);
        assertEq(repaid, debt, "HF < 0.95: full close allowed");
        // collateral = repaid * $0.55 * 1.05 / $0.80 (USDG)
        assertApproxEqAbs(seized, (repaid * 0.55e18 / 1e18) * 10_500 / 10_000 * 1e18 / 0.8e18, 2);
    }
}
