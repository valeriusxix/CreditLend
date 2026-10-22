// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {CreditLendPool} from "../src/CreditLendPool.sol";
import {CollateralManager} from "../src/CollateralManager.sol";
import {KinkedInterestRateModel} from "../src/InterestRateModel.sol";
import {FixedPriceOracle} from "../src/oracle/FixedPriceOracle.sol";
import {CreditPriceOracle} from "../src/oracle/CreditPriceOracle.sol";
import {IOrbioExchange} from "../src/interfaces/IOrbioExchange.sol";
import {IInterestRateModel} from "../src/interfaces/IInterestRateModel.sol";
import {RateController, IRateControlledPool} from "../src/RateController.sol";

/// @notice Deploys the CreditLend market on Robinhood Chain (4663) with AGENT.md §5 parameters, the
///         order-book $CREDIT price oracle (USDG fixed at $1), order-book-sized borrow caps and the
///         agent's RateController (a timelock-approved menu of three rate models).
///
/// Usage (simulation only, no broadcast):
///   ADMIN_MULTISIG=0x... GUARDIAN=0x... AGENT=0x... forge script script/Deploy.s.sol --fork-url robinhood
/// AGENT is optional (default: none); the timelock can set it later with RateController.setAgent.
///
/// When the script ends, the 2-day timelock OWNS the CollateralManager and the CreditLendPool (ownership
/// accepted, not merely pending) and the deployer's wallet holds no role anywhere (AUDIT.md H-1). The
/// deployer owns the two contracts only for the few transactions that list USDG and set the caps.
contract Deploy is Script {
    address constant CREDIT = 0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ORBIO_EXCHANGE = 0x6951fFd32630b05e06F50062AEA801625A58eBC0;

    uint256 constant TIMELOCK_DELAY = 2 days;

    // $CREDIT price oracle (approved 2026-10-21). Needs update() at least hourly (the agent reads hourly, every
    // 5 minutes when anything looks off; the price falls back to $1 after 2 hours without one). A new oracle
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

    // The agent's rate menu: it may switch the pool between these three models (approved 2026-10-21).
    // "Lower" attracts borrowers: 1% base, +6% by the 70% kink, +120% above it.
    // "Higher" attracts lenders: 4% base, +15% by the 60% kink, +200% above it.
    uint256 constant LOWER_BASE_RATE = 0.01e18;
    uint256 constant LOWER_SLOPE1 = 0.06e18;
    uint256 constant LOWER_SLOPE2 = 1.20e18;
    uint256 constant LOWER_KINK = 0.70e18;
    uint256 constant HIGHER_BASE_RATE = 0.04e18;
    uint256 constant HIGHER_SLOPE1 = 0.15e18;
    uint256 constant HIGHER_SLOPE2 = 2.00e18;
    uint256 constant HIGHER_KINK = 0.60e18;

    // A rate switch is announced 6 hours ahead, then executable for 24 hours; one switch per 24 hours.
    uint256 constant RATE_SWITCH_DELAY = 6 hours;
    uint256 constant RATE_SWITCH_COOLDOWN = 24 hours;
    uint256 constant RATE_SWITCH_GRACE = 24 hours;

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

    // What was deployed, readable by tests (test/fork/DeployOwnership.t.sol).
    address public deployer;
    CreditLendPool internal _pool;
    CollateralManager internal _cm;
    TimelockController internal _timelock;

    function deployed() external view returns (CreditLendPool, CollateralManager, TimelockController) {
        return (_pool, _cm, _timelock);
    }

    function run() external {
        address admin = vm.envAddress("ADMIN_MULTISIG");
        address guardian = vm.envAddress("GUARDIAN");
        address agent = vm.envOr("AGENT", address(0));
        require(block.chainid == 4663 || block.chainid == 46630, "wrong chain");
        require(IERC20Metadata(CREDIT).decimals() == 6, "CREDIT decimals changed");

        vm.startBroadcast();
        // The wallet actually sending the transactions (with --ledger or --account it may differ from msg.sender).
        (, deployer,) = vm.readCallers();

        require(admin != deployer, "ADMIN_MULTISIG must not be the deployer: the deployer gives up its roles");

        // The timelock starts with NO delay and the deployer as a temporary proposer/executor, so this same
        // deployment can make it accept ownership. It then sets its own 2-day delay and the deployer
        // renounces every role (below), so nothing is left pending for a hot key to abuse.
        address[] memory roles = new address[](2);
        (roles[0], roles[1]) = (admin, deployer);
        TimelockController timelock = new TimelockController(0, roles, roles, address(0));

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

        CollateralManager cm = new CollateralManager(deployer, CREDIT, oracle);
        cm.listAsset(USDG, true, USDG_LTV_BPS, USDG_LT_BPS, USDG_BONUS_BPS, USDG_SUPPLY_CAP);
        cm.transferOwnership(address(timelock));

        KinkedInterestRateModel irm = new KinkedInterestRateModel(BASE_RATE, SLOPE1, SLOPE2, KINK);
        IInterestRateModel[] memory menu = new IInterestRateModel[](3);
        menu[0] = new KinkedInterestRateModel(LOWER_BASE_RATE, LOWER_SLOPE1, LOWER_SLOPE2, LOWER_KINK);
        menu[1] = irm;
        menu[2] = new KinkedInterestRateModel(HIGHER_BASE_RATE, HIGHER_SLOPE1, HIGHER_SLOPE2, HIGHER_KINK);

        CreditLendPool pool = new CreditLendPool(
            IERC20Metadata(CREDIT),
            cm,
            irm,
            deployer,
            guardian,
            RESERVE_FACTOR_BPS,
            MAX_UTILIZATION_BPS,
            MIN_DEBT
        );
        pool.setBorrowCaps(MAX_DEBT_PER_ACCOUNT, MAX_TOTAL_BORROWS);

        // Owned by the timelock from the start: the menu is set in the constructor.
        RateController rateController = new RateController(
            IRateControlledPool(address(pool)),
            address(timelock),
            agent,
            menu,
            RATE_SWITCH_DELAY,
            RATE_SWITCH_COOLDOWN,
            RATE_SWITCH_GRACE
        );
        pool.setRateController(address(rateController));
        pool.transferOwnership(address(timelock));

        _handOver(timelock, address(cm), address(pool));

        vm.stopBroadcast();
        (_pool, _cm, _timelock) = (pool, cm, timelock);

        require(pool.maxDebtPerAccount() == MAX_DEBT_PER_ACCOUNT && pool.maxTotalBorrows() == MAX_TOTAL_BORROWS);
        require(pool.owner() == address(timelock) && cm.owner() == address(timelock), "timelock must own the market");
        _requireHandedOver(timelock, admin);
        require(pool.rateController() == address(rateController) && rateController.owner() == address(timelock));
        require(rateController.menu().length == 3 && rateController.isApproved(irm) && rateController.agent() == agent);

        require(oracle.getPrice(CREDIT) == 1e18, "new oracle must start at $1");
        require(oracle.getPrice(USDG) == 1e18);

        console.log("TimelockController", address(timelock));
        console.log("FixedPriceOracle  ", address(baseOracle), "(USDG = $1)");
        console.log("CreditPriceOracle ", address(oracle), "(run the agent: ../agent)");
        console.log("CollateralManager ", address(cm));
        console.log("InterestRateModel ", address(irm));
        console.log("CreditLendPool    ", address(pool));
        console.log("RateController    ", address(rateController), "agent:", agent);
        console.log("  lower model     ", address(menu[0]));
        console.log("  higher model    ", address(menu[2]));
    }

    /// @dev Inside the broadcast: the timelock (still at delay 0) accepts both contracts and sets its own
    ///      2-day delay in one batch, then the deployer renounces every timelock role it was given.
    function _handOver(TimelockController timelock, address cm, address pool) internal {
        address[] memory targets = new address[](3);
        (targets[0], targets[1], targets[2]) = (cm, pool, address(timelock));
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        calls[1] = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        calls[2] = abi.encodeCall(TimelockController.updateDelay, (TIMELOCK_DELAY));
        uint256[] memory values = new uint256[](3);
        timelock.scheduleBatch(targets, values, calls, bytes32(0), bytes32(0), 0);
        timelock.executeBatch(targets, values, calls, bytes32(0), bytes32(0));

        timelock.renounceRole(timelock.PROPOSER_ROLE(), deployer);
        timelock.renounceRole(timelock.CANCELLER_ROLE(), deployer);
        timelock.renounceRole(timelock.EXECUTOR_ROLE(), deployer);
    }

    function _requireHandedOver(TimelockController timelock, address admin) internal view {
        require(timelock.getMinDelay() == TIMELOCK_DELAY, "timelock delay");
        require(
            !timelock.hasRole(timelock.PROPOSER_ROLE(), deployer) && !timelock.hasRole(timelock.EXECUTOR_ROLE(), deployer)
                && !timelock.hasRole(timelock.CANCELLER_ROLE(), deployer)
                && !timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), deployer),
            "deployer kept a timelock role"
        );
        require(timelock.hasRole(timelock.PROPOSER_ROLE(), admin) && timelock.hasRole(timelock.EXECUTOR_ROLE(), admin));
    }
}
