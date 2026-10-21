// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreditLendPool} from "../src/CreditLendPool.sol";
import {CollateralManager} from "../src/CollateralManager.sol";
import {KinkedInterestRateModel} from "../src/InterestRateModel.sol";
import {MockCredit, MockERC20, MockOracle} from "./mocks/Mocks.sol";

/// @notice Shared fixture using the AGENT.md §5 starting parameters.
abstract contract BaseTest is Test {
    uint256 internal constant ONE_CREDIT = 1e6;
    uint256 internal constant ONE_USDG = 1e6;

    MockCredit internal credit;
    MockERC20 internal usdg;
    MockERC20 internal orbio;
    MockOracle internal oracle;
    CollateralManager internal cm;
    KinkedInterestRateModel internal irm;
    CreditLendPool internal pool;

    address internal owner = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");
    address internal liquidator = makeAddr("liquidator");

    function setUp() public virtual {
        vm.warp(1_700_000_000);

        credit = new MockCredit();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        orbio = new MockERC20("Orbio", "ORBIO", 18);

        oracle = new MockOracle();
        oracle.setPrice(address(credit), 1e18);
        oracle.setPrice(address(usdg), 1e18);
        oracle.setPrice(address(orbio), 0.5e18);

        cm = new CollateralManager(owner, address(credit), oracle);
        vm.startPrank(owner);
        // USDG: LTV 70%, LT 80%, bonus 5%
        cm.listAsset(address(usdg), true, 7_000, 8_000, 500, 10_000_000 * ONE_USDG);
        // ORBIO (volatile; used in tests only, not in the v1 launch config): LTV 50%, LT 65%, bonus 8%
        cm.listAsset(address(orbio), true, 5_000, 6_500, 800, 100_000_000e18);
        vm.stopPrank();

        // base 2%, slope1 10% up to the 65% kink, slope2 150% above it
        irm = new KinkedInterestRateModel(0.02e18, 0.10e18, 1.50e18, 0.65e18);

        pool = new CreditLendPool(
            credit,
            cm,
            irm,
            owner,
            guardian,
            1_000, // 10% reserve factor
            9_000, // 90% max utilization for new borrows
            10 * ONE_CREDIT // min debt
        );

        vm.label(address(pool), "pool");
        vm.label(address(credit), "CREDIT");
        vm.label(address(usdg), "USDG");
        vm.label(address(orbio), "ORBIO");
    }

    // ---------------------------------------------------------------- helpers

    function _lend(address who, uint256 amount) internal returns (uint256 shares) {
        credit.mint(who, amount);
        vm.startPrank(who);
        credit.approve(address(pool), amount);
        shares = pool.deposit(amount, who);
        vm.stopPrank();
    }

    function _postCollateral(address who, MockERC20 token, uint256 amount) internal {
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(pool), amount);
        pool.depositCollateral(address(token), amount, who);
        vm.stopPrank();
    }

    function _borrow(address who, uint256 amount) internal {
        vm.prank(who);
        pool.borrow(amount);
    }

    function _healthFactor(address who) internal view returns (uint256 hf) {
        (,,,, hf) = pool.getAccountData(who);
    }

    /// @dev Liquidator buys $CREDIT "on the market" (minted here) and liquidates.
    function _liquidate(address who, address collateral, uint256 repayAmount)
        internal
        returns (uint256 repaid, uint256 seized)
    {
        credit.mint(liquidator, repayAmount);
        vm.startPrank(liquidator);
        credit.approve(address(pool), repayAmount);
        (repaid, seized) = pool.liquidate(who, collateral, repayAmount, 0);
        vm.stopPrank();
    }
}
