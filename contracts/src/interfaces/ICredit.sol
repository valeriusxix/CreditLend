// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title ICredit
/// @notice Subset of the Orbio $CREDIT token (0xe33322da1380e61e5ae5dfb21e7f62924c73004c, chain 4663).
/// @dev Verified on-chain (2026-10-20): 6 decimals, UUPS proxy, implementation exposes `activate(uint256)`,
///      `mint(address,uint256)` and EIP-2612 `permit`.
///
///      ASSUMPTIONS (documented per AGENT.md §11):
///      - `activate(amount)` burns `amount` from msg.sender and credits msg.sender's off-chain API balance.
///        It is irreversible. The pool NEVER calls it and never holds activatable "borrowed" tokens.
///      - Borrowed $CREDIT is treated as consumed the moment it leaves the pool (decision A). The pool
///        does not attempt to detect activation: tokens are fungible once withdrawn, so activation,
///        selling or transferring are economically identical from the lenders' point of view. Lender
///        safety comes solely from overcollateralization + permissionless liquidation.
///      - $1 is treated as the price CEILING (debt valued at face value; settlement price clamped to $1).
///        Unverified: direct credit purchases reportedly carry a ~5% service fee, so the order book could
///        trade slightly above $1, which would erode liquidator margin. Revisit with the priority-2 oracle.
///      - $CREDIT is upgradeable by Orbio. A malicious/buggy upgrade (fees, blacklist, pause) is a trust
///        assumption the pool cannot remove; `_pullExact` in the pool rejects fee-on-transfer behavior.
interface ICredit is IERC20Metadata {
    function activate(uint256 amount) external;
}
