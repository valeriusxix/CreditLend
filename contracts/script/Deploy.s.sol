// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {CreditLendPool} from "../src/CreditLendPool.sol";
import {CollateralManager} from "../src/CollateralManager.sol";
import {KinkedInterestRateModel} from "../src/InterestRateModel.sol";
import {FixedPriceOracle} from "../src/oracle/FixedPriceOracle.sol";

/// @notice Deploys the v1 CreditLend market on Robinhood Chain (4663) with AGENT.md §5 parameters.
///
/// Usage (simulation only, no broadcast):
///   ADMIN_MULTISIG=0x... GUARDIAN=0x... forge script script/Deploy.s.sol --fork-url robinhood
///
/// After deployment, the CollateralManager ownership transfer is PENDING: the timelock must
/// schedule + execute `CollateralManager.acceptOwnership()` (Ownable2Step). Until then the deployer
/// remains its owner. The pool is owned by the timelock from construction.
contract Deploy is Script {
    address constant CREDIT = 0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    uint256 constant TIMELOCK_DELAY = 2 days;

    // Interest model: low base, steep above the 65% kink (AGENT.md §5).
    uint256 constant BASE_RATE = 0.02e18;
    uint256 constant SLOPE1 = 0.10e18;
    uint256 constant SLOPE2 = 1.50e18;
    uint256 constant KINK = 0.65e18;

    // Pool
    uint256 constant RESERVE_FACTOR_BPS = 1_000; // 10%
    uint256 constant MAX_UTILIZATION_BPS = 9_000; // 90%
    uint256 constant MIN_DEBT = 10e6; // 10 CREDIT

    // USDG collateral: "start tight"
    uint16 constant USDG_LTV_BPS = 7_000;
    uint16 constant USDG_LT_BPS = 8_000;
    uint16 constant USDG_BONUS_BPS = 500;
    uint256 constant USDG_SUPPLY_CAP = 1_000_000e6;

    function run() external {
        address admin = vm.envAddress("ADMIN_MULTISIG");
        address guardian = vm.envAddress("GUARDIAN");
        require(block.chainid == 4663 || block.chainid == 46630, "wrong chain");
        require(IERC20Metadata(CREDIT).decimals() == 6, "CREDIT decimals changed");

        vm.startBroadcast();

        address[] memory admins = new address[](1);
        admins[0] = admin;
        TimelockController timelock = new TimelockController(TIMELOCK_DELAY, admins, admins, address(0));

        address[] memory assets = new address[](2);
        assets[0] = CREDIT;
        assets[1] = USDG;
        uint256[] memory prices = new uint256[](2);
        prices[0] = 1e18; // face value
        prices[1] = 1e18;
        FixedPriceOracle oracle = new FixedPriceOracle(assets, prices);

        CollateralManager cm = new CollateralManager(msg.sender, CREDIT, oracle);
        cm.listAsset(USDG, true, USDG_LTV_BPS, USDG_LT_BPS, USDG_BONUS_BPS, USDG_SUPPLY_CAP);
        cm.transferOwnership(address(timelock));

        KinkedInterestRateModel irm = new KinkedInterestRateModel(BASE_RATE, SLOPE1, SLOPE2, KINK);

        CreditLendPool pool = new CreditLendPool(
            IERC20Metadata(CREDIT),
            cm,
            irm,
            address(timelock),
            guardian,
            RESERVE_FACTOR_BPS,
            MAX_UTILIZATION_BPS,
            MIN_DEBT
        );

        vm.stopBroadcast();

        console.log("TimelockController", address(timelock));
        console.log("FixedPriceOracle  ", address(oracle));
        console.log("CollateralManager ", address(cm));
        console.log("InterestRateModel ", address(irm));
        console.log("CreditLendPool    ", address(pool));
    }
}
