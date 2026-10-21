// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {CreditLendPool} from "../src/CreditLendPool.sol";
import {CollateralManager} from "../src/CollateralManager.sol";
import {KinkedInterestRateModel} from "../src/InterestRateModel.sol";
import {FixedPriceOracle} from "../src/oracle/FixedPriceOracle.sol";
import {CreditPriceOracle} from "../src/oracle/CreditPriceOracle.sol";
import {IOrbioExchange} from "../src/interfaces/IOrbioExchange.sol";

/// @notice Deploys the CreditLend market on Robinhood Chain (4663) with AGENT.md §5 parameters, the
///         order-book $CREDIT price oracle (USDG fixed at $1) and order-book-sized borrow caps.
///
/// Usage (simulation only, no broadcast):
///   ADMIN_MULTISIG=0x... GUARDIAN=0x... forge script script/Deploy.s.sol --fork-url robinhood
///
/// After deployment, the CollateralManager AND CreditLendPool ownership transfers are PENDING: the
/// timelock must schedule + execute `acceptOwnership()` on each (Ownable2Step). Until then the
/// deployer remains their owner. The deployer owns them briefly only to list USDG and set the
/// borrow caps in the same deployment.
contract Deploy is Script {
    address constant CREDIT = 0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ORBIO_EXCHANGE = 0x6951fFd32630b05e06F50062AEA801625A58eBC0;

    uint256 constant TIMELOCK_DELAY = 2 days;

    // $CREDIT price oracle (approved 2026-10-21). Needs update() every ~5 minutes; a new oracle
    // starts at $1 and takes ~30 hours of readings to come down to the market price.
    uint256 constant ORACLE_REFERENCE_SIZE = 5_000e6; // price of buying 5,000 CREDIT, fee included
    uint256 constant ORACLE_MIN_INTERVAL = 5 minutes;
    uint256 constant ORACLE_TWAP_WINDOW = 1 hours;
    uint256 constant ORACLE_MAX_STALENESS = 2 hours;
    uint256 constant ORACLE_MAX_DEVIATION_BPS = 2_500; // 25%
    uint256 constant ORACLE_MAX_DROP_BPS_PER_HOUR = 200; // 2%

    // Interest model: low base, steep above the 65% kink (AGENT.md §5).
    uint256 constant BASE_RATE = 0.02e18;
    uint256 constant SLOPE1 = 0.10e18;
    uint256 constant SLOPE2 = 1.50e18;
    uint256 constant KINK = 0.65e18;

    // Pool
    uint256 constant RESERVE_FACTOR_BPS = 1_000; // 10%
    uint256 constant MAX_UTILIZATION_BPS = 9_000; // 90%
    uint256 constant MIN_DEBT = 10e6; // 10 CREDIT

    // Borrow caps, sized to Orbio order-book depth measured 2026-10-21 (block 94,212,109): liquidating
    // 20,000 CREDIT at once still earned liquidators 2.6% (10,000, a typical half-close, 5%); the
    // whole book held ~202,000 CREDIT. Revisit as the book deepens.
    uint256 constant MAX_DEBT_PER_ACCOUNT = 20_000e6;
    uint256 constant MAX_TOTAL_BORROWS = 50_000e6;

    // USDG collateral: "start tight". 50,000 CREDIT of debt needs >= ~71,500 USDG at 70% LTV.
    uint16 constant USDG_LTV_BPS = 7_000;
    uint16 constant USDG_LT_BPS = 8_000;
    uint16 constant USDG_BONUS_BPS = 500;
    uint256 constant USDG_SUPPLY_CAP = 200_000e6;

    function run() external {
        address admin = vm.envAddress("ADMIN_MULTISIG");
        address guardian = vm.envAddress("GUARDIAN");
        require(block.chainid == 4663 || block.chainid == 46630, "wrong chain");
        require(IERC20Metadata(CREDIT).decimals() == 6, "CREDIT decimals changed");

        vm.startBroadcast();

        address[] memory admins = new address[](1);
        admins[0] = admin;
        TimelockController timelock = new TimelockController(TIMELOCK_DELAY, admins, admins, address(0));

        // USDG stays fixed at $1 (no trustworthy on-chain USDG/USD feed).
        address[] memory assets = new address[](1);
        assets[0] = USDG;
        uint256[] memory prices = new uint256[](1);
        prices[0] = 1e18;
        FixedPriceOracle baseOracle = new FixedPriceOracle(assets, prices);

        // $CREDIT is priced from the Orbio order book; every other asset passes through to baseOracle.
        CreditPriceOracle oracle = new CreditPriceOracle(
            IOrbioExchange(ORBIO_EXCHANGE),
            baseOracle,
            ORACLE_REFERENCE_SIZE,
            ORACLE_MIN_INTERVAL,
            ORACLE_TWAP_WINDOW,
            ORACLE_MAX_STALENESS,
            ORACLE_MAX_DEVIATION_BPS,
            ORACLE_MAX_DROP_BPS_PER_HOUR
        );
        require(oracle.credit() == CREDIT, "exchange is not for this CREDIT");

        CollateralManager cm = new CollateralManager(msg.sender, CREDIT, oracle);
        cm.listAsset(USDG, true, USDG_LTV_BPS, USDG_LT_BPS, USDG_BONUS_BPS, USDG_SUPPLY_CAP);
        cm.transferOwnership(address(timelock));

        KinkedInterestRateModel irm = new KinkedInterestRateModel(BASE_RATE, SLOPE1, SLOPE2, KINK);

        CreditLendPool pool = new CreditLendPool(
            IERC20Metadata(CREDIT),
            cm,
            irm,
            msg.sender,
            guardian,
            RESERVE_FACTOR_BPS,
            MAX_UTILIZATION_BPS,
            MIN_DEBT
        );
        pool.setBorrowCaps(MAX_DEBT_PER_ACCOUNT, MAX_TOTAL_BORROWS);
        pool.transferOwnership(address(timelock));

        vm.stopBroadcast();

        require(pool.maxDebtPerAccount() == MAX_DEBT_PER_ACCOUNT && pool.maxTotalBorrows() == MAX_TOTAL_BORROWS);
        require(pool.pendingOwner() == address(timelock) && cm.pendingOwner() == address(timelock));

        require(oracle.getPrice(CREDIT) == 1e18, "new oracle must start at $1");
        require(oracle.getPrice(USDG) == 1e18);

        console.log("TimelockController", address(timelock));
        console.log("FixedPriceOracle  ", address(baseOracle), "(USDG = $1)");
        console.log("CreditPriceOracle ", address(oracle), "(call update() every ~5 minutes)");
        console.log("CollateralManager ", address(cm));
        console.log("InterestRateModel ", address(irm));
        console.log("CreditLendPool    ", address(pool));
    }
}
