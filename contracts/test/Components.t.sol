// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {KinkedInterestRateModel} from "../src/InterestRateModel.sol";
import {CollateralManager} from "../src/CollateralManager.sol";
import {FixedPriceOracle} from "../src/oracle/FixedPriceOracle.sol";
import {LiquidationLogic} from "../src/libraries/LiquidationLogic.sol";
import {MockCredit, MockERC20, MockOracle} from "./mocks/Mocks.sol";

/// @dev Exposes the internal library for testing.
contract LiquidationLogicHarness {
    function computeSeize(LiquidationLogic.SeizeParams memory p) external pure returns (uint256, uint256) {
        return LiquidationLogic.computeSeize(p);
    }

    function maxRepayable(uint256 debt, uint256 hf, uint256 dust) external pure returns (uint256) {
        return LiquidationLogic.maxRepayable(debt, hf, dust);
    }
}

contract InterestRateModelTest is Test {
    KinkedInterestRateModel irm = new KinkedInterestRateModel(0.02e18, 0.10e18, 1.50e18, 0.65e18);

    function test_rates_atKeyPoints() public view {
        assertEq(irm.borrowRatePerYear(1_000, 0, 0), 0.02e18); // idle
        assertEq(irm.borrowRatePerYear(350, 650, 0), 0.12e18); // at kink
        assertEq(irm.borrowRatePerYear(0, 1_000, 0), 1.62e18); // 100%
    }

    function test_utilization_excludesReserves() public view {
        // lender assets = 500 + 500 - 100 = 900
        assertEq(irm.utilization(500, 500, 100), uint256(500e18) / 900);
        assertEq(irm.utilization(0, 100, 200), 1e18); // capped
    }

    function testFuzz_rate_monotonicInUtilization(uint128 cash, uint128 borrowsA, uint128 extra) public view {
        uint256 a = irm.borrowRatePerYear(cash, borrowsA, 0);
        uint256 b = irm.borrowRatePerYear(cash, uint256(borrowsA) + extra, 0);
        assertGe(b, a);
        assertLe(b, 1.62e18);
    }

    function test_constructor_bounds() public {
        vm.expectRevert(KinkedInterestRateModel.InvalidKink.selector);
        new KinkedInterestRateModel(0, 0, 0, 1e18);
        vm.expectRevert(KinkedInterestRateModel.RateTooHigh.selector);
        new KinkedInterestRateModel(1e18, 5e18, 5e18, 0.5e18);
    }
}

contract LiquidationLogicTest is Test {
    LiquidationLogicHarness h = new LiquidationLogicHarness();

    function test_maxRepayable() public view {
        assertEq(h.maxRepayable(1_000, 1e18, 10), 0);
        assertEq(h.maxRepayable(1_000, 0.97e18, 10), 500);
        assertEq(h.maxRepayable(1_000, 0.94e18, 10), 1_000);
        assertEq(h.maxRepayable(10, 0.99e18, 10), 10); // dust closes fully
    }

    /// Seizure never exceeds what the borrower has, never over-pays the liquidator beyond the
    /// bonus, and the liquidator never pays more than requested.
    function testFuzz_computeSeize_bounds(
        uint256 repay,
        uint256 debtPrice,
        uint256 collPrice,
        uint8 collDecimals,
        uint256 bonusBps,
        uint256 available
    ) public view {
        repay = bound(repay, 1, 1e15 * 1e6); // up to 1e15 CREDIT
        debtPrice = bound(debtPrice, 1e14, 1e18);
        collPrice = bound(collPrice, 1e10, 1e24);
        collDecimals = uint8(bound(collDecimals, 6, 18));
        bonusBps = bound(bonusBps, 100, 2_000);
        available = bound(available, 0, 1e36);

        (uint256 repaid, uint256 seized) = h.computeSeize(
            LiquidationLogic.SeizeParams(repay, debtPrice, 6, collPrice, collDecimals, bonusBps, available)
        );

        assertLe(repaid, repay);
        assertLe(seized, available);

        uint256 seizedValue = LiquidationLogic.toValue(seized, collPrice, collDecimals, Math.Rounding.Floor);
        uint256 repaidValue = LiquidationLogic.toValue(repaid, debtPrice, 6, Math.Rounding.Ceil);
        // Liquidator receives at most repaid value * (1 + bonus).
        assertLe(seizedValue, Math.mulDiv(repaidValue, 10_000 + bonusBps, 10_000) + 1);
    }
}

contract CollateralManagerTest is Test {
    MockCredit credit = new MockCredit();
    MockERC20 usdg = new MockERC20("USDG", "USDG", 6);
    MockOracle oracle = new MockOracle();
    address owner = makeAddr("owner");
    CollateralManager cm;

    function setUp() public {
        oracle.setPrice(address(credit), 1e18);
        oracle.setPrice(address(usdg), 1e18);
        cm = new CollateralManager(owner, address(credit), oracle);
    }

    function test_rejectsDebtAssetAsCollateral() public {
        vm.prank(owner);
        vm.expectRevert(CollateralManager.DebtAssetNotAllowedAsCollateral.selector);
        cm.listAsset(address(credit), true, 7_000, 8_000, 500, 1);
    }

    function test_rejectsUnsafeConfigs() public {
        vm.startPrank(owner);
        vm.expectRevert(CollateralManager.InvalidConfig.selector); // LTV >= LT
        cm.listAsset(address(usdg), true, 8_000, 8_000, 500, 1);
        vm.expectRevert(CollateralManager.InvalidConfig.selector); // LT * (1 + bonus) > 100%
        cm.listAsset(address(usdg), true, 8_000, 9_500, 600, 1);
        vm.expectRevert(CollateralManager.InvalidConfig.selector); // bonus too small
        cm.listAsset(address(usdg), true, 7_000, 8_000, 50, 1);
        cm.listAsset(address(usdg), true, 7_000, 8_000, 500, 1);
        vm.expectRevert(CollateralManager.AlreadyListed.selector);
        cm.listAsset(address(usdg), true, 7_000, 8_000, 500, 1);
        vm.stopPrank();
    }

    function test_rejectsAssetWithoutPrice() public {
        MockERC20 unpriced = new MockERC20("X", "X", 18);
        vm.prank(owner);
        vm.expectRevert("no price");
        cm.listAsset(address(unpriced), true, 7_000, 8_000, 500, 1);
    }

    function test_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        cm.listAsset(address(usdg), true, 7_000, 8_000, 500, 1);
    }

    function test_collateralValue_andSettlementPrice() public {
        vm.prank(owner);
        cm.listAsset(address(usdg), true, 7_000, 8_000, 500, 1);
        (uint256 v, uint256 bp, uint256 lv) = cm.collateralValue(address(usdg), 1_000e6);
        assertEq(v, 1_000e18);
        assertEq(bp, 700e18);
        assertEq(lv, 800e18);

        oracle.setPrice(address(credit), 1.3e18);
        assertEq(cm.getDebtSettlementPrice(), 1e18);
        oracle.setPrice(address(credit), 0.6e18);
        assertEq(cm.getDebtSettlementPrice(), 0.6e18);
    }

    function test_setOracle_requiresPricesForAllAssets() public {
        vm.prank(owner);
        cm.listAsset(address(usdg), true, 7_000, 8_000, 500, 1);

        address[] memory assets = new address[](1);
        assets[0] = address(credit);
        uint256[] memory prices = new uint256[](1);
        prices[0] = 1e18;
        FixedPriceOracle incomplete = new FixedPriceOracle(assets, prices);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FixedPriceOracle.PriceUnavailable.selector, address(usdg)));
        cm.setOracle(incomplete);
    }
}
