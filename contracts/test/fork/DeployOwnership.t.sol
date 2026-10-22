// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {CreditLendPool} from "../../src/CreditLendPool.sol";
import {CollateralManager} from "../../src/CollateralManager.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// AUDIT.md H-1: when the deploy script finishes, the 2-day timelock must ALREADY own the pool and the
/// CollateralManager, and the deployer's wallet must hold no power at all. Runs the real script against
/// a fork of Robinhood Chain (needs network: FOUNDRY_PROFILE=fork forge test).
contract DeployOwnershipForkTest is Test {
    address constant ADMIN = address(0xA11CE);
    address constant GUARDIAN = address(0x6A2D);

    function test_fork_afterDeploy_timelockOwnsEverything_deployerHasNoPower() public {
        vm.createSelectFork("robinhood");
        vm.setEnv("ADMIN_MULTISIG", vm.toString(ADMIN));
        vm.setEnv("GUARDIAN", vm.toString(GUARDIAN));
        vm.setEnv("AGENT", vm.toString(address(0)));

        Deploy script = new Deploy();
        vm.recordLogs();
        script.run();
        (CreditLendPool pool, CollateralManager cm, TimelockController timelock) = script.deployed();
        address deployer = script.deployer();

        assertEq(pool.owner(), address(timelock), "pool owned by the timelock");
        assertEq(cm.owner(), address(timelock), "CollateralManager owned by the timelock");
        assertEq(pool.pendingOwner(), address(0));
        assertEq(cm.pendingOwner(), address(0));
        assertEq(timelock.getMinDelay(), 2 days, "2-day delay in force");

        // The deployer can't touch the market or the timelock any more.
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), deployer));
        assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), deployer));
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), deployer));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), deployer));
        IPriceOracle current = cm.oracle();
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        cm.setOracle(current);

        // The admin multisig keeps its roles.
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), ADMIN));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), ADMIN));
    }
}
