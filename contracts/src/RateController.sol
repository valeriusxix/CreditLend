// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IInterestRateModel} from "./interfaces/IInterestRateModel.sol";

interface IRateControlledPool {
    function interestRateModel() external view returns (IInterestRateModel);
    function guardian() external view returns (address);
    function setInterestRateModel(IInterestRateModel newModel) external;
}

/// @title RateController
/// @notice The agent's only on-chain power (AGENT.md §4.1 "AgentVault / Role"): switching the pool
///         between interest-rate models that the timelocked owner has approved in advance.
///
///         1. The owner (timelock) approves a menu of rate models.
///         2. The agent proposes one of them. It becomes executable after `delay`, so users see every
///            rate change coming.
///         3. After the delay, anyone may execute it (within `gracePeriod`, otherwise it expires).
///         4. The guardian or the owner may cancel a pending proposal at any time.
///         5. The agent may propose again only `cooldown` after the last EXECUTED switch.
///
/// @dev Holds no funds and can't change anything but the rate model. The pool must name this
///      contract as its `rateController`. The owner can still set any model directly on the pool.
contract RateController is Ownable2Step {
    IRateControlledPool public immutable pool;

    /// @notice Time between a proposal and the earliest moment it can be executed.
    uint256 public immutable delay;
    /// @notice Minimum time between an executed switch and the agent's next proposal.
    uint256 public immutable cooldown;
    /// @notice How long an executable proposal stays executable before it expires.
    uint256 public immutable gracePeriod;

    uint256 public constant MIN_DELAY = 1 hours;
    uint256 public constant MAX_DELAY = 7 days;
    uint256 public constant MIN_GRACE_PERIOD = 1 hours;

    address public agent;

    mapping(IInterestRateModel model => bool) public isApproved;
    IInterestRateModel[] private _menu;

    struct Proposal {
        IInterestRateModel model; // zero = nothing pending
        uint64 executableAt;
    }

    Proposal public pending;

    /// @notice Time of the last executed switch (0 = never).
    uint256 public lastExecutedAt;

    event AgentUpdated(address indexed agent);
    event ModelApproved(address indexed model);
    event ModelRemoved(address indexed model);
    event SwitchProposed(address indexed model, uint256 executableAt);
    event SwitchExecuted(address indexed model);
    event SwitchCancelled(address indexed model, address indexed by);

    error ZeroAddress();
    error InvalidParameter();
    error NotAgent();
    error NotGuardianOrOwner();
    error AlreadyApproved();
    error NotApproved();
    error AlreadyCurrent();
    error ProposalPending();
    error NoProposal();
    error CooldownActive(uint256 nextAllowed);
    error TooEarly(uint256 executableAt);
    error ProposalExpired();

    constructor(
        IRateControlledPool pool_,
        address owner_,
        address agent_,
        IInterestRateModel[] memory menu_,
        uint256 delay_,
        uint256 cooldown_,
        uint256 gracePeriod_
    ) Ownable(owner_) {
        if (address(pool_) == address(0)) revert ZeroAddress();
        if (delay_ < MIN_DELAY || delay_ > MAX_DELAY || cooldown_ < delay_ || gracePeriod_ < MIN_GRACE_PERIOD) {
            revert InvalidParameter();
        }
        pool = pool_;
        delay = delay_;
        cooldown = cooldown_;
        gracePeriod = gracePeriod_;
        agent = agent_;
        emit AgentUpdated(agent_);
        for (uint256 i; i < menu_.length; ++i) {
            _approve(menu_[i]);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Owner (timelock)
    // ---------------------------------------------------------------------------------------------

    /// @notice Zero disables the agent.
    function setAgent(address newAgent) external onlyOwner {
        agent = newAgent;
        emit AgentUpdated(newAgent);
    }

    function approveModel(IInterestRateModel model) external onlyOwner {
        _approve(model);
    }

    /// @notice Removing a model also blocks a pending switch to it (checked again at execution).
    function removeModel(IInterestRateModel model) external onlyOwner {
        if (!isApproved[model]) revert NotApproved();
        isApproved[model] = false;
        uint256 n = _menu.length;
        for (uint256 i; i < n; ++i) {
            if (_menu[i] == model) {
                _menu[i] = _menu[n - 1];
                _menu.pop();
                break;
            }
        }
        emit ModelRemoved(address(model));
    }

    // ---------------------------------------------------------------------------------------------
    // Agent
    // ---------------------------------------------------------------------------------------------

    /// @notice Announces a switch to an approved model, executable after `delay`.
    ///         An expired proposal is replaced; a live one must be executed or cancelled first.
    function propose(IInterestRateModel model) external {
        if (msg.sender != agent || msg.sender == address(0)) revert NotAgent();
        if (!isApproved[model]) revert NotApproved();
        if (pool.interestRateModel() == model) revert AlreadyCurrent();
        if (address(pending.model) != address(0) && block.timestamp <= pending.executableAt + gracePeriod) {
            revert ProposalPending();
        }
        if (lastExecutedAt != 0 && block.timestamp < lastExecutedAt + cooldown) {
            revert CooldownActive(lastExecutedAt + cooldown);
        }
        uint256 executableAt = block.timestamp + delay;
        pending = Proposal(model, uint64(executableAt));
        emit SwitchProposed(address(model), executableAt);
    }

    // ---------------------------------------------------------------------------------------------
    // Anyone / guardian
    // ---------------------------------------------------------------------------------------------

    /// @notice Applies the pending switch once its delay has passed. Permissionless.
    function execute() external {
        Proposal memory p = pending;
        if (address(p.model) == address(0)) revert NoProposal();
        if (block.timestamp < p.executableAt) revert TooEarly(p.executableAt);
        if (block.timestamp > p.executableAt + gracePeriod) revert ProposalExpired();
        if (!isApproved[p.model]) revert NotApproved();
        delete pending;
        lastExecutedAt = block.timestamp;
        pool.setInterestRateModel(p.model);
        emit SwitchExecuted(address(p.model));
    }

    /// @notice The pool's guardian or this contract's owner may cancel a pending switch.
    function cancel() external {
        if (msg.sender != pool.guardian() && msg.sender != owner()) revert NotGuardianOrOwner();
        IInterestRateModel model = pending.model;
        if (address(model) == address(0)) revert NoProposal();
        delete pending;
        emit SwitchCancelled(address(model), msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function menu() external view returns (IInterestRateModel[] memory) {
        return _menu;
    }

    function currentModel() external view returns (IInterestRateModel) {
        return pool.interestRateModel();
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _approve(IInterestRateModel model) internal {
        if (address(model) == address(0)) revert ZeroAddress();
        if (isApproved[model]) revert AlreadyApproved();
        model.borrowRatePerSecond(0, 0, 0); // sanity: must be a working rate model
        isApproved[model] = true;
        _menu.push(model);
        emit ModelApproved(address(model));
    }
}
