// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BaseTest} from "./BaseTest.sol";
import {CreditLendPool} from "../src/CreditLendPool.sol";
import {KinkedInterestRateModel} from "../src/InterestRateModel.sol";
import {FeeOnTransferToken} from "./mocks/Mocks.sol";

contract CreditLendPoolTest is BaseTest {
    // ============================================================ lender

    function test_lender_depositAndWithdraw_roundTrip() public {
        uint256 shares = _lend(lender, 1_000 * ONE_CREDIT);
        assertEq(pool.balanceOf(lender), shares);
        assertEq(pool.cash(), 1_000 * ONE_CREDIT);
        assertEq(pool.totalAssets(), 1_000 * ONE_CREDIT);

        vm.prank(lender);
        pool.redeem(shares, lender, lender);
        assertEq(credit.balanceOf(lender), 1_000 * ONE_CREDIT);
        assertEq(pool.cash(), 0);
    }

    function test_lender_earnsInterest_minusReserveFactor() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 700 * ONE_CREDIT);

        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest();

        uint256 interest = pool.totalBorrows() - 700 * ONE_CREDIT;
        assertGt(interest, 0);
        // 70% utilization is above the 65% kink: 2% + 10% + 150% * 5/35 ~= 33.43% APR
        assertApproxEqRel(interest, (700 * ONE_CREDIT * 334_285_714) / 1e9, 1e-6 * 1e18);
        assertApproxEqAbs(pool.totalReserves(), interest / 10, 1);
        assertApproxEqAbs(pool.totalAssets(), 1_000 * ONE_CREDIT + interest - interest / 10, 1);
        // Per-account debt rounds UP (protocol-favoring); the aggregate rounds down.
        assertGe(pool.debtOf(borrower), pool.totalBorrows());
        assertApproxEqAbs(pool.debtOf(borrower), pool.totalBorrows(), 1);
    }

    function test_lender_withdrawLimitedByLiquidity() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 700 * ONE_CREDIT);

        assertEq(pool.maxWithdraw(lender), 300 * ONE_CREDIT);
        vm.prank(lender);
        vm.expectRevert();
        pool.withdraw(300 * ONE_CREDIT + 1, lender, lender);

        vm.prank(lender);
        pool.withdraw(300 * ONE_CREDIT, lender, lender);
        assertEq(pool.cash(), 0);
    }

    function test_inflationAttack_isNeutralized() public {
        address attacker = makeAddr("attacker");
        _lend(attacker, 1);
        // Direct donation: ignored by internal accounting.
        credit.mint(attacker, 10_000 * ONE_CREDIT);
        vm.prank(attacker);
        credit.transfer(address(pool), 10_000 * ONE_CREDIT);
        assertEq(pool.totalAssets(), 1);

        uint256 shares = _lend(lender, 1_000 * ONE_CREDIT);
        assertApproxEqAbs(pool.previewRedeem(shares), 1_000 * ONE_CREDIT, 1);
    }

    /// AUDIT.md L-1: accrued every second (anyone may call accrueInterest), each second's interest on a
    /// small market was less than one atom and rounded to zero, so lenders' share price never moved while
    /// the borrower's debt kept growing. The pool's total must keep pace with the real debt.
    function test_lender_frequentAccrual_doesNotLoseInterest() public {
        _lend(lender, 100 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 100 * ONE_USDG);
        _borrow(borrower, 50 * ONE_CREDIT);
        uint256 assetsBefore = pool.totalAssets();

        for (uint256 i; i < 3_600; ++i) {
            vm.warp(block.timestamp + 1);
            pool.accrueInterest();
        }

        uint256 debtGrowth = pool.debtOf(borrower) - 50 * ONE_CREDIT;
        assertGt(debtGrowth, 0);
        assertApproxEqAbs(pool.totalBorrows(), 50 * ONE_CREDIT + debtGrowth, 2, "total keeps pace with the real debt");
        assertLe(pool.totalBorrows(), pool.debtOf(borrower), "never above the real debt");
        assertGt(pool.totalAssets(), assetsBefore, "lenders' share price rose");
    }

    // ============================================================ borrow limits

    function test_borrow_upToLtv() public {
        _lend(lender, 10_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);

        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.InsufficientCollateral.selector);
        pool.borrow(700 * ONE_CREDIT + 1);

        _borrow(borrower, 700 * ONE_CREDIT);
        assertEq(credit.balanceOf(borrower), 700 * ONE_CREDIT);
        assertEq(pool.debtOf(borrower), 700 * ONE_CREDIT);
        // HF = 1000 * 80% / 700
        assertApproxEqAbs(_healthFactor(borrower), uint256(800e18) / 700, 1);
    }

    function test_borrow_debtValuedAtFaceValue_evenIfCreditTradesAtDiscount() public {
        _lend(lender, 10_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        oracle.setPrice(address(credit), 0.5e18); // market discount must NOT increase borrow power

        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.InsufficientCollateral.selector);
        pool.borrow(700 * ONE_CREDIT + 1);
    }

    function test_borrow_respectsUtilizationCap() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 10_000 * ONE_USDG);

        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.UtilizationCapExceeded.selector);
        pool.borrow(900 * ONE_CREDIT + 1);

        _borrow(borrower, 900 * ONE_CREDIT);
    }

    function test_borrow_minDebt() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.DebtBelowMinimum.selector);
        pool.borrow(10 * ONE_CREDIT - 1);
    }

    function test_borrow_withoutCollateralReverts() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.InsufficientCollateral.selector);
        pool.borrow(10 * ONE_CREDIT);
    }

    // ============================================================ repay & collateral

    function test_repayFull_thenWithdrawAllCollateral() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 500 * ONE_CREDIT);
        vm.warp(block.timestamp + 30 days);

        uint256 debt = pool.debtOf(borrower);
        assertGt(debt, 500 * ONE_CREDIT);
        credit.mint(borrower, debt - 500 * ONE_CREDIT); // borrower buys the interest on the market
        vm.startPrank(borrower);
        credit.approve(address(pool), type(uint256).max);
        uint256 repaid = pool.repay(type(uint256).max, borrower);
        assertEq(repaid, debt);
        assertEq(pool.debtOf(borrower), 0);

        pool.withdrawCollateral(address(usdg), type(uint256).max, borrower);
        vm.stopPrank();
        assertEq(usdg.balanceOf(borrower), 1_000 * ONE_USDG);
        assertEq(pool.totalCollateral(address(usdg)), 0);
    }

    function test_repay_onBehalfOf() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 500 * ONE_CREDIT);

        address friend = makeAddr("friend");
        credit.mint(friend, 200 * ONE_CREDIT);
        vm.startPrank(friend);
        credit.approve(address(pool), 200 * ONE_CREDIT);
        pool.repay(200 * ONE_CREDIT, borrower);
        vm.stopPrank();
        assertEq(pool.debtOf(borrower), 300 * ONE_CREDIT);
    }

    function test_withdrawCollateral_blockedIfItBreaksLtv() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 350 * ONE_CREDIT);

        // 350 debt needs 500 USDG at 70% LTV, so up to 500 may leave.
        vm.startPrank(borrower);
        vm.expectRevert(CreditLendPool.InsufficientCollateral.selector);
        pool.withdrawCollateral(address(usdg), 500 * ONE_USDG + 1, borrower);
        pool.withdrawCollateral(address(usdg), 500 * ONE_USDG, borrower);
        vm.stopPrank();
    }

    function test_collateral_supplyCapAndDisabledAsset() public {
        vm.prank(owner);
        cm.updateAssetConfig(address(usdg), true, 7_000, 8_000, 500, 100 * ONE_USDG);
        usdg.mint(borrower, 1_000 * ONE_USDG);
        vm.startPrank(borrower);
        usdg.approve(address(pool), type(uint256).max);
        vm.expectRevert(CreditLendPool.SupplyCapExceeded.selector);
        pool.depositCollateral(address(usdg), 100 * ONE_USDG + 1, borrower);
        vm.stopPrank();

        vm.prank(owner);
        cm.updateAssetConfig(address(usdg), false, 7_000, 8_000, 500, 100 * ONE_USDG);
        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.AssetNotAccepted.selector);
        pool.depositCollateral(address(usdg), 1, borrower);
    }

    function test_feeOnTransferCollateral_isRejected() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        oracle.setPrice(address(fee), 1e18);
        vm.prank(owner);
        cm.listAsset(address(fee), true, 7_000, 8_000, 500, type(uint256).max);

        fee.mint(borrower, 1_000 * ONE_USDG);
        vm.startPrank(borrower);
        fee.approve(address(pool), type(uint256).max);
        vm.expectRevert(CreditLendPool.UnexpectedTransferAmount.selector);
        pool.depositCollateral(address(fee), 1_000 * ONE_USDG, borrower);
        vm.stopPrank();
    }

    // ============================================================ activation (decision A)

    /// Borrower borrows and ACTIVATES (burns) all borrowed $CREDIT. The tokens are gone for good;
    /// lenders must be made whole by liquidators using market $CREDIT + the borrower's collateral.
    function test_activation_lendersMadeWholeFromCollateral() public {
        uint256 lenderShares = _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 700 * ONE_CREDIT);

        vm.prank(borrower);
        credit.activate(700 * ONE_CREDIT);
        assertEq(credit.balanceOf(borrower), 0);
        assertEq(credit.apiBalance(borrower), 700 * ONE_CREDIT);

        // Borrower never repays. Interest pushes HF below 1.
        vm.warp(block.timestamp + 180 days);
        assertLt(_healthFactor(borrower), 1e18);
        assertGe(_healthFactor(borrower), 0.95e18); // only the 50% close factor applies

        _liquidate(borrower, address(usdg), type(uint128).max);
        assertGt(_healthFactor(borrower), 1e18, "partial liquidation restores health");

        // Push to full liquidation (e.g. USDG wobble), then close the rest.
        oracle.setPrice(address(usdg), 0.7e18);
        _liquidate(borrower, address(usdg), type(uint128).max);
        assertEq(pool.debtOf(borrower), 0, "debt fully repaid with market CREDIT");
        assertEq(pool.totalBorrows(), 0);

        // Lender exits with principal + interest.
        vm.prank(lender);
        uint256 out = pool.redeem(lenderShares, lender, lender);
        assertGt(out, 1_000 * ONE_CREDIT, "lender made whole, plus interest");
    }

    // ============================================================ liquidation

    function _openStandardPosition() internal {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 700 * ONE_CREDIT);
    }

    function test_liquidation_healthyPositionReverts() public {
        _openStandardPosition();
        credit.mint(liquidator, 100 * ONE_CREDIT);
        vm.startPrank(liquidator);
        credit.approve(address(pool), type(uint256).max);
        vm.expectRevert(CreditLendPool.PositionHealthy.selector);
        pool.liquidate(borrower, address(usdg), 100 * ONE_CREDIT, 0);
        vm.stopPrank();
    }

    function test_liquidation_partial_closeFactor50() public {
        _openStandardPosition();
        oracle.setPrice(address(usdg), 0.86e18); // HF = 860 * 0.8 / 700 = 0.9829

        (uint256 repaid, uint256 seized) = _liquidate(borrower, address(usdg), 700 * ONE_CREDIT);
        assertEq(repaid, 350 * ONE_CREDIT);
        // 350 * $1 * 1.05 / $0.86
        assertEq(seized, 427_325_581);
        assertEq(usdg.balanceOf(liquidator), seized);
        assertEq(pool.debtOf(borrower), 350 * ONE_CREDIT);
        assertEq(pool.collateralOf(borrower, address(usdg)), 1_000 * ONE_USDG - seized);
    }

    function test_liquidation_full_belowHf095() public {
        _openStandardPosition();
        oracle.setPrice(address(usdg), 0.8e18); // HF = 0.914

        (uint256 repaid, uint256 seized) = _liquidate(borrower, address(usdg), 700 * ONE_CREDIT);
        assertEq(repaid, 700 * ONE_CREDIT);
        assertEq(seized, 918_750_000); // 700 * 1.05 / 0.8
        assertEq(pool.debtOf(borrower), 0);
        assertEq(pool.collateralOf(borrower, address(usdg)), 81_250_000); // borrower keeps the rest
    }

    function test_liquidation_usesDiscountedSettlementPrice() public {
        _openStandardPosition();
        oracle.setPrice(address(usdg), 0.8e18);
        oracle.setPrice(address(credit), 0.7e18); // CREDIT trades at 30% discount

        (uint256 repaid, uint256 seized) = _liquidate(borrower, address(usdg), 700 * ONE_CREDIT);
        assertEq(repaid, 700 * ONE_CREDIT);
        // 700 * $0.70 * 1.05 / $0.80: the liquidator gets no windfall from the discount
        assertEq(seized, 643_125_000);
    }

    function test_liquidation_settlementPriceCappedAtFaceValue() public {
        _openStandardPosition();
        oracle.setPrice(address(usdg), 0.8e18);
        oracle.setPrice(address(credit), 5e18); // manipulated high

        (, uint256 seized) = _liquidate(borrower, address(usdg), 700 * ONE_CREDIT);
        assertEq(seized, 918_750_000); // same as at $1
    }

    function test_liquidation_slippageGuard() public {
        _openStandardPosition();
        oracle.setPrice(address(usdg), 0.8e18);
        credit.mint(liquidator, 700 * ONE_CREDIT);
        vm.startPrank(liquidator);
        credit.approve(address(pool), type(uint256).max);
        vm.expectRevert(CreditLendPool.SlippageExceeded.selector);
        pool.liquidate(borrower, address(usdg), 700 * ONE_CREDIT, 918_750_001);
        vm.stopPrank();
    }

    function test_liquidation_badDebt_coveredByReservesThenLenders() public {
        _lend(lender, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, orbio, 2_000e18); // $1000 at $0.50
        _borrow(borrower, 500 * ONE_CREDIT);

        vm.warp(block.timestamp + 90 days);
        pool.accrueInterest();
        uint256 reservesBefore = pool.totalReserves();
        assertGt(reservesBefore, 0);
        uint256 assetsBefore = pool.totalAssets();

        oracle.setPrice(address(orbio), 0.2e18); // crash: collateral now $400
        uint256 debt = pool.debtOf(borrower);

        (uint256 repaid, uint256 seized) = _liquidate(borrower, address(orbio), debt);
        assertEq(seized, 2_000e18, "all collateral seized");
        assertLt(repaid, debt);

        uint256 badDebt = debt - repaid;
        assertEq(pool.debtOf(borrower), 0, "residual debt written off");
        assertEq(pool.totalReserves(), 0, "reserves absorb first loss");
        assertApproxEqAbs(pool.totalAssets(), assetsBefore - (badDebt - reservesBefore), 2, "lenders take the rest");
    }

    /// AUDIT.md M-2: one atom of another collateral, sent by anyone just before the liquidation, used to
    /// stop the write-off. The unpaid debt stayed counted as a lender asset, so the first lender out got
    /// everything back and the last one carried the whole loss.
    function test_liquidation_dustCollateral_doesNotBlockBadDebtWriteOff() public {
        address lender2 = makeAddr("lender2");
        _lend(lender, 1_000 * ONE_CREDIT);
        _lend(lender2, 1_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _borrow(borrower, 700 * ONE_CREDIT);
        oracle.setPrice(address(usdg), 0.5e18); // collateral $500 < debt 700

        orbio.mint(lender, 1); // a lender who knows the trick sends the borrower 1 wei of ORBIO
        vm.startPrank(lender);
        orbio.approve(address(pool), 1);
        pool.depositCollateral(address(orbio), 1, borrower);
        vm.stopPrank();

        _liquidate(borrower, address(usdg), 700 * ONE_CREDIT);
        assertEq(pool.debtOf(borrower), 0, "unpaid debt written off despite the dust");
        assertEq(pool.collateralOf(borrower, address(orbio)), 1, "dust stays with the borrower");

        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        assertLt(pool.redeem(shares, lender, lender), 900 * ONE_CREDIT, "first lender out shares the loss");
    }

    /// The dust rule must not write off debt that real collateral can still pay: $1 or more left over is
    /// liquidated as usual.
    function test_liquidation_meaningfulLeftoverCollateral_isNotWrittenOff() public {
        _lend(lender, 2_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 1_000 * ONE_USDG);
        _postCollateral(borrower, orbio, 40e18); // $20 at $0.50
        _borrow(borrower, 700 * ONE_CREDIT);
        oracle.setPrice(address(usdg), 0.5e18);

        _liquidate(borrower, address(usdg), 700 * ONE_CREDIT); // takes all the USDG
        uint256 left = pool.debtOf(borrower);
        assertGt(left, 0, "$20 of ORBIO can still repay part: not written off");
        (uint256 repaid,) = _liquidate(borrower, address(orbio), left);
        assertGt(repaid, 0);
        assertEq(pool.debtOf(borrower), 0, "written off once the ORBIO is gone");
    }

    // ============================================================ pause semantics

    function test_pause_onlyBlocksRiskIncreasingActions() public {
        _openStandardPosition();

        vm.prank(guardian);
        pool.pause(true, true, true);

        // Blocked
        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.ActionPaused.selector);
        pool.borrow(10 * ONE_CREDIT);

        credit.mint(lender, 1 * ONE_CREDIT);
        vm.startPrank(lender);
        credit.approve(address(pool), type(uint256).max);
        vm.expectRevert();
        pool.deposit(1 * ONE_CREDIT, lender);
        vm.stopPrank();

        // Always available: repay, withdraw, liquidate
        credit.mint(borrower, 0); // borrower still holds the borrowed 700
        vm.startPrank(borrower);
        credit.approve(address(pool), type(uint256).max);
        pool.repay(100 * ONE_CREDIT, borrower);
        vm.stopPrank();

        vm.prank(lender);
        pool.withdraw(100 * ONE_CREDIT, lender, lender);

        oracle.setPrice(address(usdg), 0.7e18);
        _liquidate(borrower, address(usdg), 600 * ONE_CREDIT);
    }

    function test_pause_guardianCannotUnpause() public {
        vm.prank(guardian);
        pool.pause(false, true, false);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        pool.unpause(false, true, false);

        vm.prank(owner);
        pool.unpause(false, true, false);
        assertFalse(pool.borrowsPaused());
    }

    function test_pause_strangerCannotPause() public {
        vm.prank(borrower);
        vm.expectRevert(CreditLendPool.NotGuardianOrOwner.selector);
        pool.pause(true, true, true);
    }

    // ============================================================ admin

    function test_setInterestRateModel_accruesAtOldRateFirst() public {
        _openStandardPosition();
        vm.warp(block.timestamp + 100 days);
        uint256 debtBefore = pool.debtOf(borrower);

        KinkedInterestRateModel zero = new KinkedInterestRateModel(0, 0, 0, 0.5e18);
        vm.prank(owner);
        pool.setInterestRateModel(zero);
        assertApproxEqAbs(pool.totalBorrows(), debtBefore, 1, "old rate applied up to the switch");
        debtBefore = pool.debtOf(borrower);

        vm.warp(block.timestamp + 100 days);
        assertEq(pool.debtOf(borrower), debtBefore, "new (zero) rate applies afterwards");
    }

    function test_admin_onlyOwner() public {
        vm.startPrank(borrower);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, borrower));
        pool.setReserveFactor(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, borrower));
        pool.reduceReserves(1, borrower);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, borrower));
        pool.skim(address(credit), borrower);
        vm.stopPrank();
    }

    function test_skim_onlyRemovesExcess() public {
        _openStandardPosition();
        credit.mint(address(pool), 5 * ONE_CREDIT); // accidental transfer
        usdg.mint(address(pool), 3 * ONE_USDG);

        vm.startPrank(owner);
        pool.skim(address(credit), owner);
        pool.skim(address(usdg), owner);
        vm.expectRevert(CreditLendPool.ZeroAmount.selector);
        pool.skim(address(usdg), owner);
        vm.stopPrank();

        assertEq(credit.balanceOf(owner), 5 * ONE_CREDIT);
        assertEq(usdg.balanceOf(owner), 3 * ONE_USDG);
        assertEq(IERC20(address(credit)).balanceOf(address(pool)), pool.cash());
        assertEq(usdg.balanceOf(address(pool)), pool.totalCollateral(address(usdg)));
    }

    function test_reduceReserves() public {
        _openStandardPosition();
        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest();
        uint256 reserves = pool.totalReserves();
        uint256 assetsBefore = pool.totalAssets();

        vm.prank(owner);
        pool.reduceReserves(reserves, owner);
        assertEq(credit.balanceOf(owner), reserves);
        assertEq(pool.totalReserves(), 0);
        assertEq(pool.totalAssets(), assetsBefore, "lender assets untouched");
    }
}
