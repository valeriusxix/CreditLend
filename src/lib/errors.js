// Turns wallet and contract errors into one plain-English sentence.
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem'

// Every custom error the pool, CollateralManager and token can revert with (src/abi).
export const REVERT_MESSAGES = {
  ZeroAmount: 'Enter more than zero.',
  ZeroShares: 'That amount is too small to deposit.',
  ZeroAddress: 'An address is missing.',
  ActionPaused: 'This action is paused by the guardian right now. Repaying, withdrawing and liquidating always work.',
  InsufficientLiquidity: 'The pool does not have that much $CREDIT available right now. Try a smaller amount.',
  InsufficientCollateral: 'Not enough collateral: this would take you past your borrowing limit.',
  InsufficientCollateralBalance: 'You do not have that much of this collateral deposited.',
  UtilizationCapExceeded: 'The pool keeps some $CREDIT free for lenders to withdraw; this borrow would go past that limit. Try a smaller amount.',
  DebtBelowMinimum: 'Your total debt would be below the minimum loan size.',
  AccountDebtCapExceeded: 'This would go over the maximum debt one account may have.',
  TotalBorrowCapExceeded: 'The market has reached its total borrowing limit.',
  NoDebt: 'There is no debt to repay.',
  PositionHealthy: 'This position is healthy (health factor at or above 1), so it cannot be liquidated.',
  AssetNotAccepted: 'This token is not accepted as collateral right now.',
  SupplyCapExceeded: 'This collateral has reached its deposit limit.',
  LiquidationTooSmall: 'This liquidation is too small to go through.',
  SlippageExceeded: 'Prices moved and you would receive less collateral than expected. Refresh and try again.',
  UnexpectedTransferAmount: 'The token moved a different amount than expected, so the pool refused it.',
  ERC20InsufficientBalance: 'Your wallet does not hold enough of this token.',
  ERC20InsufficientAllowance: 'The approval is too small. Try again; the app will ask for a new approval.',
  ERC4626ExceededMaxWithdraw: 'You cannot withdraw that much: either you do not have it or the pool lacks free $CREDIT right now.',
  ERC4626ExceededMaxRedeem: 'You cannot withdraw that much: either you do not have it or the pool lacks free $CREDIT right now.',
  ERC4626ExceededMaxDeposit: 'Lender deposits are paused right now.',
  NotListed: 'This token is not listed as collateral.',
  InvalidPrice: 'This collateral has no price right now.',
}

/// The custom error name a contract call reverted with, or null.
export function revertName(err) {
  if (!(err instanceof BaseError)) return null
  return err.walk((e) => e instanceof ContractFunctionRevertedError)?.data?.errorName ?? null
}

export function isUserRejection(err) {
  if (err?.code === 4001) return true
  if (!(err instanceof BaseError)) return false
  return Boolean(err.walk((e) => e instanceof UserRejectedRequestError || e?.code === 4001))
}

export function friendlyError(err) {
  if (isUserRejection(err)) return 'You cancelled the request in your wallet.'
  const name = revertName(err)
  if (name) return REVERT_MESSAGES[name] ?? `The transaction would fail (${name}).`
  const text = err?.shortMessage ?? err?.message ?? String(err)
  if (/insufficient funds/i.test(text)) return 'Your wallet does not have enough ETH to pay for gas on Robinhood Chain.'
  return text.split('\n')[0]
}
