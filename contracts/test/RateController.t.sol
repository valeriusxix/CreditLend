// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BaseTest} from "./BaseTest.sol";
import {CreditLendPool} from "../src/CreditLendPool.sol";
import {KinkedInterestRateModel} from "../src/InterestRateModel.sol";
import {IInterestRateModel} from "../src/interfaces/IInterestRateModel.sol";
import {RateController, IRateControlledPool} from "../src/RateController.sol";

/// The agent may only switch between timelock-approved rate models, after a public delay, at most once
/// per cooldown, and the guardian can cancel.
contract RateControllerTest is BaseTest {
    uint256 constant DELAY = 6 hours;
    uint256 constant COOLDOWN = 24 hours;
    uint256 constant GRACE = 24 hours;

    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    KinkedInterestRateModel lower;
    KinkedInterestRateModel higher;
    RateController rc;

    function setUp() public override {
        super.setUp();
        lower = new KinkedInterestRateModel(0.01e18, 0.06e18, 1.20e18, 0.70e18);
        higher = new KinkedInterestRateModel(0.04e18, 0.15e18, 2.00e18, 0.60e18);

        IInterestRateModel[] memory menu = new IInterestRateModel[](3);
        menu[0] = lower;
        menu[1] = irm; // "normal", the pool's current model
        menu[2] = higher;
        rc = new RateController(IRateControlledPool(address(pool)), owner, agent, menu, DELAY, COOLDOWN, GRACE);

        vm.prank(owner);
        pool.setRateController(address(rc));
    }

    function _propose(IInterestRateModel m) internal {
        vm.prank(agent);
        rc.propose(m);
    }

    // ------------------------------------------------------------------ happy path

    function test_proposeWaitExecute_switchesModel() public {
        _propose(higher);
        (IInterestRateModel m, uint64 at) = rc.pending();
        assertEq(address(m), address(higher));
        assertEq(at, block.timestamp + DELAY);

        vm.expectRevert(abi.encodeWithSelector(RateController.TooEarly.selector, block.timestamp + DELAY));
        rc.execute();

        vm.warp(block.timestamp + DELAY);
        vm.prank(stranger); // anyone may execute
        rc.execute();
        assertEq(address(pool.interestRateModel()), address(higher));
        (m,) = rc.pending();
        assertEq(address(m), address(0));
    }

    function test_execute_accruesAtOldRateFirst() public {
        _lend(lender, 10_000 * ONE_CREDIT);
        _postCollateral(borrower, usdg, 10_000 * ONE_USDG);
        _borrow(borrower, 5_000 * ONE_CREDIT);

        _propose(lower);
        vm.warp(block.timestamp + DELAY);
        uint256 debtBefore = pool.debtOf(borrower); // includes interest at the old rate
        rc.execute();
        assertEq(pool.lastAccrualTimestamp(), block.timestamp);
        assertApproxEqAbs(pool.totalBorrows(), debtBefore, 1);
    }

    // ------------------------------------------------------------------ restrictions

    function test_onlyAgentCanPropose() public {
        vm.prank(stranger);
        vm.expectRevert(RateController.NotAgent.selector);
        rc.propose(higher);

        vm.prank(owner);
        vm.expectRevert(RateController.NotAgent.selector);
        rc.propose(higher);
    }

    function test_agentDisabled_cannotPropose() public {
        vm.prank(owner);
        rc.setAgent(address(0));
        vm.prank(agent);
        vm.expectRevert(RateController.NotAgent.selector);
        rc.propose(higher);
    }

    function test_unapprovedModel_rejected() public {
        KinkedInterestRateModel rogue = new KinkedInterestRateModel(0, 0, 0, 0.5e18);
        vm.prank(agent);
        vm.expectRevert(RateController.NotApproved.selector);
        rc.propose(rogue);
    }

    function test_currentModel_rejected() public {
        vm.prank(agent);
        vm.expectRevert(RateController.AlreadyCurrent.selector);
        rc.propose(irm);
    }

    function test_onePendingAtATime_expiredCanBeReplaced() public {
        _propose(higher);
        vm.prank(agent);
        vm.expectRevert(RateController.ProposalPending.selector);
        rc.propose(lower);

        vm.warp(block.timestamp + DELAY + GRACE); // last executable second
        vm.prank(agent);
        vm.expectRevert(RateController.ProposalPending.selector);
        rc.propose(lower);

        vm.warp(block.timestamp + 1); // expired
        vm.expectRevert(RateController.ProposalExpired.selector);
        rc.execute();
        _propose(lower);
        (IInterestRateModel m,) = rc.pending();
        assertEq(address(m), address(lower));
    }

    function test_cooldown_countsFromExecution() public {
        _propose(higher);
        vm.warp(block.timestamp + DELAY);
        rc.execute();
        uint256 executedAt = block.timestamp;

        vm.warp(executedAt + COOLDOWN - 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(RateController.CooldownActive.selector, executedAt + COOLDOWN));
        rc.propose(irm);

        vm.warp(executedAt + COOLDOWN);
        _propose(irm);
    }

    function test_guardianOrOwnerCanCancel_strangerCannot() public {
        _propose(higher);
        vm.prank(stranger);
        vm.expectRevert(RateController.NotGuardianOrOwner.selector);
        rc.cancel();

        vm.prank(agent);
        vm.expectRevert(RateController.NotGuardianOrOwner.selector);
        rc.cancel();

        vm.expectEmit(address(rc));
        emit RateController.SwitchCancelled(address(higher), guardian);
        vm.prank(guardian);
        rc.cancel();

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(RateController.NoProposal.selector);
        rc.execute();
        assertEq(address(pool.interestRateModel()), address(irm));

        // A cancelled proposal still starts the cooldown (approved 2026-10-22): a stolen agent key can't
        // keep re-proposing after every cancel.
        uint256 nextAllowed = rc.lastProposedAt() + COOLDOWN;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(RateController.CooldownActive.selector, nextAllowed));
        rc.propose(lower);
    }

    function test_removedModel_blocksPendingSwitch() public {
        _propose(higher);
        vm.prank(owner);
        rc.removeModel(higher);
        assertFalse(rc.isApproved(higher));
        assertEq(rc.menu().length, 2);

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(RateController.NotApproved.selector);
        rc.execute();
    }

    function test_menuManagement_onlyOwner() public {
        KinkedInterestRateModel extra = new KinkedInterestRateModel(0.03e18, 0.12e18, 1.80e18, 0.65e18);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        rc.approveModel(extra);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        rc.setAgent(agent);

        vm.startPrank(owner);
        rc.approveModel(extra);
        vm.expectRevert(RateController.AlreadyApproved.selector);
        rc.approveModel(extra);
        vm.stopPrank();
        assertEq(rc.menu().length, 4);
    }

    function test_constructor_validatesTimings() public {
        IInterestRateModel[] memory none = new IInterestRateModel[](0);
        IRateControlledPool p = IRateControlledPool(address(pool));
        vm.expectRevert(RateController.InvalidParameter.selector);
        new RateController(p, owner, agent, none, 30 minutes, COOLDOWN, GRACE); // delay too short
        vm.expectRevert(RateController.InvalidParameter.selector);
        new RateController(p, owner, agent, none, DELAY, 1 hours, GRACE); // cooldown < delay
        vm.expectRevert(RateController.InvalidParameter.selector);
        new RateController(p, owner, agent, none, DELAY, COOLDOWN, 0); // no grace period
        vm.expectRevert(RateController.ZeroAddress.selector);
        new RateController(IRateControlledPool(address(0)), owner, agent, none, DELAY, COOLDOWN, GRACE);
    }

    function test_cooldown_countsFromProposal_evenIfCancelled() public {
        uint256 proposedAt = block.timestamp;
        _propose(higher);
        assertEq(rc.lastProposedAt(), proposedAt);
        assertEq(rc.nextProposalAllowed(), proposedAt + COOLDOWN);
        vm.prank(guardian);
        rc.cancel();

        vm.warp(proposedAt + COOLDOWN - 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(RateController.CooldownActive.selector, proposedAt + COOLDOWN));
        rc.propose(lower);

        vm.warp(proposedAt + COOLDOWN);
        _propose(lower);
    }

    /// A compromised agent key can force at most one cancel per cooldown on the guardian.
    function test_stolenAgentKey_atMostOneProposalPerCooldown() public {
        uint256 start = block.timestamp;
        uint256 proposals;
        for (uint256 h; h < 72; ++h) {
            vm.warp(start + h * 1 hours);
            vm.prank(agent);
            try rc.propose(h % 2 == 0 ? higher : lower) {
                ++proposals;
                vm.prank(guardian);
                rc.cancel();
            } catch {}
        }
        assertEq(proposals, 3, "72 hours: one proposal per 24 hours");
    }

    function test_cooldown_alsoCountsFromExecution() public {
        _propose(higher);
        vm.warp(block.timestamp + DELAY);
        rc.execute();
        assertEq(rc.nextProposalAllowed(), block.timestamp + COOLDOWN, "later of proposal+24h and execution+24h");
    }

    // ------------------------------------------------------------------ pool hook

    function test_pool_strangerStillGetsOwnableRevert() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pool.setInterestRateModel(higher);

        // the agent can't bypass the controller
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        pool.setInterestRateModel(higher);
    }

    function test_pool_ownerCanStillSetModelDirectly() public {
        vm.prank(owner);
        pool.setInterestRateModel(higher);
        assertEq(address(rc.currentModel()), address(higher));
    }

    function test_pool_onlyOwnerSetsController_andUnsetDisablesIt() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pool.setRateController(stranger);

        _propose(higher);
        vm.expectEmit(address(pool));
        emit CreditLendPool.RateControllerUpdated(address(0));
        vm.prank(owner);
        pool.setRateController(address(0));

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(rc)));
        rc.execute();
    }
}
