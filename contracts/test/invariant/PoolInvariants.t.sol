// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {BaseTest} from "../BaseTest.sol";
import {CreditLendPool} from "../../src/CreditLendPool.sol";
import {MockCredit, MockERC20, MockOracle} from "../mocks/Mocks.sol";

/// @notice Drives the pool with random sequences of user actions, price shocks, time jumps,
///         activations and liquidations.
contract PoolHandler is Test {
    CreditLendPool public pool;
    MockCredit public credit;
    MockERC20 public usdg;
    MockERC20 public orbio;
    MockOracle public oracle;

    address[] public lenders;
    address[] public borrowers;
    address public liquidator = makeAddr("inv-liquidator");

    // Ghosts
    bool public badDebtOccurred;
    bool public sharePriceDropWithoutBadDebt;
    uint256 public lastSharePrice;
    uint256 public calls;
    uint256 public successfulBorrows;
    uint256 public successfulLiquidations;
    uint256 public liquidationAttempts;
    bytes public lastLiquidationError;

    constructor(CreditLendPool pool_, MockCredit credit_, MockERC20 usdg_, MockERC20 orbio_, MockOracle oracle_) {
        pool = pool_;
        credit = credit_;
        usdg = usdg_;
        orbio = orbio_;
        oracle = oracle_;
        for (uint256 i; i < 3; ++i) {
            lenders.push(makeAddr(string.concat("lender", vm.toString(i))));
            borrowers.push(makeAddr(string.concat("borrower", vm.toString(i))));
        }
        // Seed liquidity and collateral so deep paths (borrow -> shock -> liquidate) are reachable.
        credit.mint(lenders[0], 2_000_000e6);
        vm.startPrank(lenders[0]);
        credit.approve(address(pool), type(uint256).max);
        pool.deposit(2_000_000e6, lenders[0]);
        vm.stopPrank();
        for (uint256 i; i < borrowers.length; ++i) {
            usdg.mint(borrowers[i], 100_000e6);
            orbio.mint(borrowers[i], 200_000e18);
            vm.startPrank(borrowers[i]);
            usdg.approve(address(pool), type(uint256).max);
            orbio.approve(address(pool), type(uint256).max);
            pool.depositCollateral(address(usdg), 100_000e6, borrowers[i]);
            pool.depositCollateral(address(orbio), 200_000e18, borrowers[i]);
            vm.stopPrank();
        }
        lastSharePrice = pool.convertToAssets(1e18);
    }

    /// Set by `liquidate` when bad debt is written off in the current call. Only that call may lower
    /// the share price; the baseline is then reset, so later unexplained drops are still caught.
    bool private _badDebtThisCall;

    modifier track() {
        _;
        ++calls;
        uint256 price = pool.convertToAssets(1e18);
        if (price + 1 < lastSharePrice && !_badDebtThisCall) sharePriceDropWithoutBadDebt = true;
        lastSharePrice = price;
        _badDebtThisCall = false;
    }

    function getBorrowers() external view returns (address[] memory) {
        return borrowers;
    }

    function getLenders() external view returns (address[] memory) {
        return lenders;
    }

    // ------------------------------------------------------------------ actions

    function lend(uint256 seed, uint256 amount) external track {
        address who = lenders[seed % lenders.length];
        amount = bound(amount, 1e6, 1_000_000e6);
        credit.mint(who, amount);
        vm.startPrank(who);
        credit.approve(address(pool), amount);
        pool.deposit(amount, who);
        vm.stopPrank();
    }

    function withdraw(uint256 seed, uint256 amount) external track {
        address who = lenders[seed % lenders.length];
        uint256 max = pool.maxWithdraw(who);
        if (max == 0) return;
        amount = bound(amount, 1, max);
        vm.prank(who);
        pool.withdraw(amount, who, who);
    }

    function postCollateral(uint256 seed, uint256 amount, bool useOrbio) external track {
        address who = borrowers[seed % borrowers.length];
        MockERC20 token = useOrbio ? orbio : usdg;
        amount = useOrbio ? bound(amount, 1e18, 1_000_000e18) : bound(amount, 1e6, 1_000_000e6);
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(pool), amount);
        pool.depositCollateral(address(token), amount, who);
        vm.stopPrank();
    }

    function borrow(uint256 seed, uint256 amount) external track {
        address who = borrowers[seed % borrowers.length];
        (uint256 borrowPower,,, uint256 debtValue,) = pool.getAccountData(who);
        if (borrowPower <= debtValue) return;
        uint256 room = (borrowPower - debtValue) / 1e12; // WAD USD -> CREDIT units at $1
        if (room < 10e6) return;
        amount = (room * bound(amount, 50, 100)) / 100; // borrow aggressively so liquidations happen
        vm.prank(who);
        try pool.borrow(amount) {
            ++successfulBorrows;
        } catch {}
    }

    function activate(uint256 seed, uint256 amount) external track {
        address who = borrowers[seed % borrowers.length];
        uint256 bal = credit.balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(who);
        credit.activate(amount);
    }

    function repay(uint256 seed, uint256 amount) external track {
        address who = borrowers[seed % borrowers.length];
        uint256 debt = pool.debtOf(who);
        if (debt == 0) return;
        amount = bound(amount, 1, debt);
        credit.mint(who, amount); // bought on the market
        vm.startPrank(who);
        credit.approve(address(pool), amount);
        pool.repay(amount, who);
        vm.stopPrank();
    }

    function warp(uint256 secs) external track {
        vm.warp(block.timestamp + bound(secs, 1, 60 days));
        pool.accrueInterest();
    }

    function shockPrices(uint256 usdgPrice, uint256 orbioPrice, uint256 creditPrice) external track {
        oracle.setPrice(address(usdg), bound(usdgPrice, 0.5e18, 1.05e18));
        oracle.setPrice(address(orbio), bound(orbioPrice, 0.02e18, 2e18));
        oracle.setPrice(address(credit), bound(creditPrice, 0.3e18, 1.2e18));
    }

    /// Acts like a liquidation bot: sweeps every unhealthy borrower.
    function liquidate(bool preferOrbio) external track {
        for (uint256 i; i < borrowers.length; ++i) {
            address who = borrowers[i];
            (,,,, uint256 hf) = pool.getAccountData(who);
            if (hf >= 1e18) continue;
            address asset = preferOrbio ? address(orbio) : address(usdg);
            if (pool.collateralOf(who, asset) == 0) asset = preferOrbio ? address(usdg) : address(orbio);

            ++liquidationAttempts;
            uint256 debt = pool.debtOf(who);
            credit.mint(liquidator, debt);
            vm.startPrank(liquidator);
            credit.approve(address(pool), debt);
            try pool.liquidate(who, asset, debt, 0) returns (uint256 repaid, uint256) {
                ++successfulLiquidations;
                // Debt gone but not fully repaid => the remainder was written off.
                if (repaid < debt && pool.debtOf(who) == 0) {
                    badDebtOccurred = true;
                    _badDebtThisCall = true;
                }
            } catch (bytes memory err) {
                lastLiquidationError = err;
            }
            vm.stopPrank();
        }
    }
}

contract PoolInvariantTest is BaseTest {
    PoolHandler handler;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        cm.updateAssetConfig(address(usdg), true, 7_000, 8_000, 500, type(uint256).max);
        vm.prank(owner);
        cm.updateAssetConfig(address(orbio), true, 5_000, 6_500, 800, type(uint256).max);

        handler = new PoolHandler(pool, credit, usdg, orbio, oracle);
        targetContract(address(handler));
    }

    /// Coverage report: confirms the interesting paths actually execute (run with -vv).
    function afterInvariant() public view {
        console.log("calls", handler.calls());
        console.log("borrows", handler.successfulBorrows());
        console.log("liquidations", handler.successfulLiquidations());
        console.log("liqAttempts", handler.liquidationAttempts());
        console.logBytes(handler.lastLiquidationError());
        console.log("badDebt", handler.badDebtOccurred());
    }

    /// Internal cash is always fully backed by real $CREDIT held by the pool.
    function invariant_cashBacked() public view {
        assertGe(credit.balanceOf(address(pool)), pool.cash());
    }

    /// Collateral accounting matches custody exactly, per asset and per user.
    function invariant_collateralBacked() public view {
        address[] memory bs = handler.getBorrowers();
        uint256 sumUsdg;
        uint256 sumOrbio;
        for (uint256 i; i < bs.length; ++i) {
            sumUsdg += pool.collateralOf(bs[i], address(usdg));
            sumOrbio += pool.collateralOf(bs[i], address(orbio));
        }
        assertEq(sumUsdg, pool.totalCollateral(address(usdg)));
        assertEq(sumOrbio, pool.totalCollateral(address(orbio)));
        assertEq(usdg.balanceOf(address(pool)), pool.totalCollateral(address(usdg)));
        assertEq(orbio.balanceOf(address(pool)), pool.totalCollateral(address(orbio)));
    }

    /// The pool never credits lenders with debt nobody owes (beyond rounding dust).
    function invariant_totalBorrowsMatchesAccountDebts() public view {
        address[] memory bs = handler.getBorrowers();
        uint256 sumDebt;
        for (uint256 i; i < bs.length; ++i) {
            sumDebt += pool.debtOf(bs[i]);
        }
        assertLe(pool.totalBorrows(), sumDebt + 10, "phantom debt");
        assertApproxEqAbs(pool.totalBorrows(), sumDebt, handler.calls() + 10, "drift");
    }

    /// No debt can exist without collateral behind it (bad debt is always written off).
    function invariant_noZombieDebt() public view {
        address[] memory bs = handler.getBorrowers();
        for (uint256 i; i < bs.length; ++i) {
            if (pool.debtOf(bs[i]) == 0) continue;
            bool hasCollateral =
                pool.collateralOf(bs[i], address(usdg)) > 0 || pool.collateralOf(bs[i], address(orbio)) > 0;
            assertTrue(hasCollateral, "debt without collateral");
        }
    }

    /// Lenders' share price only falls when bad debt is realized.
    function invariant_sharePriceMonotonicAbsentBadDebt() public view {
        assertFalse(handler.sharePriceDropWithoutBadDebt());
    }

    /// Reserves are always a claim on real pool assets.
    function invariant_reservesWithinPoolAssets() public view {
        assertLe(pool.totalReserves(), pool.cash() + pool.totalBorrows());
    }

    /// Lenders' total redeemable value covers their share supply at the current price.
    function invariant_sharesBackedByAssets() public view {
        assertGe(pool.totalAssets() + 1, pool.convertToAssets(pool.totalSupply()));
    }
}
