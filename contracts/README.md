# CreditLend contracts

A fully collateralized $CREDIT lending market on Robinhood Chain (4663).
`../Agent.Md` is the spec. This folder implements **build priority 1**: the core pool, collateral, interest accrual and liquidation, all on-chain.

```
forge build
forge test              # unit + fuzz + invariant (16k randomized calls)
ADMIN_MULTISIG=0x.. GUARDIAN=0x.. forge script script/Deploy.s.sol --fork-url robinhood   # dry run
```

## Contracts

| Contract | Role | Holds funds? |
|---|---|---|
| `CreditLendPool` | Lender deposits (ERC-4626 `cCREDIT`), collateral custody, borrow / repay / liquidate, interest accrual | **Yes, all of them** |
| `CollateralManager` | Per-asset LTV / liquidation threshold / bonus / supply cap; price routing | No |
| `KinkedInterestRateModel` | Utilization curve; immutable params | No |
| `LiquidationLogic` (library) | Health factor, close factor, seize math | No |
| `FixedPriceOracle` | v1 prices (CREDIT = $1, USDG = $1), immutable | No |

Owner of the pool and CollateralManager = `TimelockController` (2-day delay). The guardian can only **pause** risk-increasing actions.

## Design decisions (agreed 2026-10-20)

1. **Borrowed $CREDIT is consumed (decision A).** Once borrowed $CREDIT leaves the pool, it is fungible tokens in the borrower's wallet. Activation, selling and transferring can't be told apart on-chain, and each is final from the lender's view. So the pool doesn't try to detect activation. Lenders are protected only by overcollateralization plus permissionless liquidation. Liquidators repay with *market* $CREDIT, never "the same tokens". See `test_activation_lendersMadeWholeFromCollateral`.
2. **Debt is valued at the $1 face value for every health check.** This is the conservative choice for a debt asset, and it needs no oracle on the debt side. Liquidation seizures are sized with a separate *settlement price* clamped to ≤ $1. Once a market oracle exists, a liquidator buying discounted $CREDIT gets no windfall from the borrower. **In v1 the fixed oracle sets the settlement price to $1, so the windfall still exists.** See limitations below.
3. **Interest accrues in $CREDIT** through a global borrow index. A 10% reserve factor builds a first-loss buffer. USDG or native-token rewards are a later, separate incentive layer.
4. **v1 collateral is USDG only.** ORBIO and other volatile assets wait for the priority-2 oracle.

## Safety properties

- Internal accounting (`cash`, `totalCollateral`). Donations don't move prices, and together with a 6-decimal share offset this blocks ERC-4626 inflation attacks.
- Rounding always favors lenders: debt rounds up, and collateral paid out rounds down.
- `LTV < LT` and `LT × (1 + bonus) ≤ 100%` are enforced for every asset, so a liquidation at HF = 1 never creates bad debt.
- Close factor: 50% of debt per liquidation, or 100% when HF < 0.95 or debt ≤ `minDebt` (dust).
- Bad debt is written off once a borrower has no collateral left. Reserves absorb it first, and any remainder lowers the cCREDIT share price.
- Fee-on-transfer behavior is rejected (`_pullExact`), because CREDIT and USDG are both upgradeable proxies.
- Pausing never blocks repay, liquidate, lender withdrawals or collateral withdrawals. Only the timelocked owner can unpause.
- New borrows are rejected above 90% utilization, keeping a liquidity buffer for lenders.
- Invariants fuzzed (`test/invariant`): cash and collateral fully backed, total borrows equal to the sum of account debts, no debt without collateral, and a share price that never drops unless bad debt is realized.

## Documented assumptions and known limitations

- **$CREDIT** (`0xe333…004c`): 6 decimals, a UUPS proxy that exposes `activate(uint256)`, `mint` and `permit` (verified on-chain 2026-10-20). Orbio can upgrade it, and that trust assumption can't be removed. The pool never calls `activate`.
- **USDG** (6 decimals) is also an upgradeable proxy.
- The **v1 fixed oracle can't see a USDG depeg.** The mitigation is the guardian pausing borrows and collateral deposits, then a timelocked switch to the priority-2 oracle.
- **Liquidation windfall in v1.** The settlement price is the fixed $1. If $CREDIT trades at $0.70, a liquidator pays $0.70 per CREDIT and receives $1.05 of the borrower's USDG. Lenders are unaffected, but borrowers who get liquidated lose more than the market cost of their debt. This ends when the priority-2 oracle supplies a market settlement price.
- **The $1 ceiling is an assumption.** Buying credits directly reportedly carries a ~5% service fee, so the order book may trade slightly *above* $1. With the settlement price clamped at $1 and a 5% bonus, liquidator margin would then shrink toward zero. Priority 2 must either make the clamp configurable or keep the bonus above the observed maximum premium.
- **One unpriceable asset blocks the whole account.** Health checks price every asset a borrower holds. If any of those prices reverts, that borrower can't borrow or withdraw, and can't be liquidated even through a different, healthy asset. Anyone can deposit collateral on a borrower's behalf, so a borrower could deliberately add a sliver of an asset whose breaker has tripped. This can't happen in v1 (one asset, immutable oracle). **Hard requirement for priority 2:** liquidation must not revert because of an unpriceable side asset (for example, value it at 0 for liquidation purposes). Repay always works.
- After deployment, `CollateralManager` ownership is **pending** until the timelock executes `acceptOwnership()`.
- Not audited yet.

## Next (spec §9)

2. Price oracle: order book TWAP + Uniswap + circuit breakers, implementing `IPriceOracle`.
3. Agent role: bounded, delayed rate-model updates through `setInterestRateModel`. No access to funds.
