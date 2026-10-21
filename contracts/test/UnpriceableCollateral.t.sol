// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./BaseTest.sol";
import {CreditLendPool} from "../src/CreditLendPool.sol";

/// Requirement (b): an asset whose price can't be read counts as $0 and never freezes an account.
/// "Unpriceable" is simulated by setting the mock oracle's price to 0, which makes it revert.
contract UnpriceableCollateralTest is BaseTest {
    function _breakOrbioFeed() internal {
        oracle.setPrice(address(orbio), 0);
        vm.expectRevert("no price");
        cm.getPrice(address(orbio));
    }

    function test_tryCollateralValue_reportsInsteadOfReverting() public {
        _breakOrbioFeed();
        (bool priced, uint256 value, uint256 bp, uint256 lv) = cm.tryCollateralValue(address(orbio), 1e18);
        assertFalse(priced);
        assertEq(value + bp + lv, 0);

        (priced, value,,) = cm.tryCollateralValue(address(usdg), 1e6);
        assertTrue(priced);
        assertEq(value, 1e18);

        (priced,,,) = cm.tryCollateralValue(makeAddr("unlisted"), 1);
        assertFalse(priced);
    }

    function test_accountData_doesNotRevert_unpriceableCountsAsZero() public {
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _postCollateral(borrower, orbio, 1_000e18); // $500
        _breakOrbioFeed();

        (uint256 borrowPower, uint256 liqValue,,,) = pool.getAccountData(borrower);
        assertEq(borrowPower, 700e18, "only USDG counts");
        assertEq(liqValue, 800e18);
    }

    /// The scenario from limitation #3: someone deposits a sliver of an asset whose feed is
    /// broken into a borrower's account. Before this fix that froze the account.
    function test_griefingSliver_cannotFreezeAccount() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 500 * ONE_CREDIT);

        address griefer = makeAddr("griefer");
        orbio.mint(griefer, 1);
        vm.startPrank(griefer);
        orbio.approve(address(pool), 1);
        pool.depositCollateral(address(orbio), 1, borrower);
        vm.stopPrank();
        _breakOrbioFeed();

        // Borrower can still borrow and withdraw against USDG.
        _borrow(borrower, 100 * ONE_CREDIT);
        vm.prank(borrower);
        pool.withdrawCollateral(address(usdg), 100 * ONE_USDG, borrower);

        // And can still be liquidated through USDG.
        oracle.setPrice(address(usdg), 0.8e18);
        (uint256 repaid, uint256 seized) = _liquidate(borrower, address(usdg), 600 * ONE_CREDIT);
        assertGt(repaid, 0);
        assertGt(seized, 0);
    }

    function test_liquidation_worksThroughPriceableCollateral() public {
        _lend(lender, 2_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG); // borrow power $700
        _postCollateral(borrower, orbio, 1_000e18); // $500 at $0.50 -> borrow power $250
        _borrow(borrower, 900 * ONE_CREDIT);

        _breakOrbioFeed(); // ORBIO now counts $0: HF = 800 / 900 = 0.889
        (,,,, uint256 hf) = pool.getAccountData(borrower);
        assertLt(hf, 0.95e18);

        // Seizing the unpriceable asset itself is not possible (its price is unknown)...
        credit.mint(liquidator, 100 * ONE_CREDIT);
        vm.startPrank(liquidator);
        credit.approve(address(pool), type(uint256).max);
        vm.expectRevert("no price");
        pool.liquidate(borrower, address(orbio), 100 * ONE_CREDIT, 0);
        vm.stopPrank();

        // ...but liquidating through the priceable USDG works.
        (uint256 repaid, uint256 seized) = _liquidate(borrower, address(usdg), 900 * ONE_CREDIT);
        assertEq(repaid, 900 * ONE_CREDIT, "HF < 0.95: whole debt");
        assertEq(seized, 945 * ONE_USDG, "USDG at $1 + 5% bonus");
        assertEq(pool.debtOf(borrower), 0);
        assertEq(pool.collateralOf(borrower, address(orbio)), 1_000e18, "ORBIO left to the borrower");
    }

    function test_borrowAgainstOnlyUnpriceableCollateral_isRefusedCleanly() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, orbio, 1_000e18);
        _breakOrbioFeed();

        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.InsufficientCollateral.selector);
        pool.borrow(10 * ONE_CREDIT);
    }

    function test_withdraw_judgedOnPriceableCollateral() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _postCollateral(borrower, orbio, 1_000e18);
        _borrow(borrower, 350 * ONE_CREDIT);
        _breakOrbioFeed();

        vm.startPrank(borrower);
        // 350 debt needs 500 USDG at 70% LTV (ORBIO counts $0), so 500 may leave, not more.
        vm.expectRevert(CreditLendPool.InsufficientCollateral.selector);
        pool.withdrawCollateral(address(usdg), 500 * ONE_USDG + 1, borrower);
        pool.withdrawCollateral(address(usdg), 500 * ONE_USDG, borrower);
        vm.stopPrank();
    }

    function test_repay_alwaysWorks_andCollateralReleasedWhenDebtFree() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _postCollateral(borrower, orbio, 1_000e18);
        _borrow(borrower, 300 * ONE_CREDIT);
        _breakOrbioFeed();

        vm.startPrank(borrower);
        credit.approve(address(pool), type(uint256).max);
        pool.repay(type(uint256).max, borrower);
        // Debt-free: even the unpriceable asset can be withdrawn (no price needed).
        pool.withdrawCollateral(address(orbio), type(uint256).max, borrower);
        vm.stopPrank();
        assertEq(orbio.balanceOf(borrower), 1_000e18);
    }
}
