// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BaseTest} from "./BaseTest.sol";
import {CreditLendPool} from "../src/CreditLendPool.sol";

/// Borrow caps keep positions within what the thin $CREDIT order book can liquidate at a profit.
contract BorrowCapsTest is BaseTest {
    uint256 constant PER_ACCOUNT = 20_000 * ONE_CREDIT;
    uint256 constant TOTAL = 50_000 * ONE_CREDIT;

    address b2 = makeAddr("borrower2");
    address b3 = makeAddr("borrower3");
    address b4 = makeAddr("borrower4");

    function setUp() public override {
        super.setUp();
        _lend(lender, 100_000 * ONE_CREDIT);
        vm.prank(owner);
        pool.setBorrowCaps(PER_ACCOUNT, TOTAL);
        address[4] memory bs = [borrower, b2, b3, b4];
        for (uint256 i; i < bs.length; ++i) {
            _postCollateral(bs[i], usdg, 40_000 * ONE_USDG); // borrow power 28,000
        }
    }

    function test_defaults_areUnlimited() public {
        CreditLendPool fresh = new CreditLendPool(credit, cm, irm, owner, guardian, 1_000, 9_000, 10 * ONE_CREDIT);
        assertEq(fresh.maxDebtPerAccount(), type(uint256).max);
        assertEq(fresh.maxTotalBorrows(), type(uint256).max);
    }

    function test_perAccountCap() public {
        _borrow(borrower, PER_ACCOUNT);
        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.AccountDebtCapExceeded.selector);
        pool.borrow(1);
    }

    function test_perAccountCap_inOneBorrow() public {
        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.AccountDebtCapExceeded.selector);
        pool.borrow(PER_ACCOUNT + 1);
    }

    function test_totalCap() public {
        _borrow(borrower, 20_000 * ONE_CREDIT);
        _borrow(b2, 20_000 * ONE_CREDIT);
        _borrow(b3, 10_000 * ONE_CREDIT);
        assertEq(pool.totalBorrows(), TOTAL);

        vm.prank(b4);
        vm.expectRevert(CreditLendPool.TotalBorrowCapExceeded.selector);
        pool.borrow(10 * ONE_CREDIT);
    }

    function test_repayFreesRoom() public {
        _borrow(borrower, 20_000 * ONE_CREDIT);
        _borrow(b2, 20_000 * ONE_CREDIT);
        _borrow(b3, 10_000 * ONE_CREDIT);

        vm.startPrank(b3);
        credit.approve(address(pool), type(uint256).max);
        pool.repay(5_000 * ONE_CREDIT, b3);
        vm.stopPrank();

        _borrow(b4, 5_000 * ONE_CREDIT);
        assertEq(pool.totalBorrows(), TOTAL);
    }

    /// Interest can take a position above the caps. That must never block repaying, withdrawing
    /// spare collateral or liquidation; only new borrowing stops.
    function test_aboveCapThroughInterest_exitsAndLiquidationStillWork() public {
        _borrow(borrower, PER_ACCOUNT);
        vm.warp(block.timestamp + 365 days);
        uint256 debt = pool.debtOf(borrower);
        assertGt(debt, PER_ACCOUNT, "interest pushed it above the cap");

        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.AccountDebtCapExceeded.selector);
        pool.borrow(10 * ONE_CREDIT);

        // Withdraw spare collateral: still allowed while the remaining collateral covers the debt.
        vm.prank(borrower);
        pool.withdrawCollateral(address(usdg), 1_000 * ONE_USDG, borrower);

        // Partial repay works.
        vm.startPrank(borrower);
        credit.approve(address(pool), type(uint256).max);
        pool.repay(1_000 * ONE_CREDIT, borrower);
        vm.stopPrank();

        // Liquidation works (39,000 USDG at $0.60 * 80% = 18,720 vs ~20,030 debt: HF ~0.93).
        oracle.setPrice(address(usdg), 0.6e18);
        (,,,, uint256 hf) = pool.getAccountData(borrower);
        assertLt(hf, 1e18);
        (uint256 repaid,) = _liquidate(borrower, address(usdg), pool.debtOf(borrower));
        assertGt(repaid, 0);
    }

    function test_onlyOwnerCanSetCaps_andEventEmitted() public {
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, borrower));
        pool.setBorrowCaps(type(uint256).max, type(uint256).max);

        vm.expectEmit(address(pool));
        emit CreditLendPool.BorrowCapsUpdated(30_000 * ONE_CREDIT, 80_000 * ONE_CREDIT);
        vm.prank(owner);
        pool.setBorrowCaps(30_000 * ONE_CREDIT, 80_000 * ONE_CREDIT);
        assertEq(pool.maxDebtPerAccount(), 30_000 * ONE_CREDIT);
        assertEq(pool.maxTotalBorrows(), 80_000 * ONE_CREDIT);
    }

    function test_capZero_stopsNewBorrowingOnly() public {
        _borrow(borrower, 1_000 * ONE_CREDIT);
        vm.prank(owner);
        pool.setBorrowCaps(0, 0);

        vm.prank(b2);
        vm.expectRevert(CreditLendPool.AccountDebtCapExceeded.selector);
        pool.borrow(10 * ONE_CREDIT);

        vm.startPrank(borrower);
        credit.approve(address(pool), type(uint256).max);
        pool.repay(type(uint256).max, borrower);
        pool.withdrawCollateral(address(usdg), type(uint256).max, borrower);
        vm.stopPrank();
    }
}
