# CreditLend contracts

A fully collateralized $CREDIT lending market on Robinhood Chain (4663).
`../Agent.Md` is the spec. This folder implements **build priority 1** (the core pool, collateral, interest accrual and liquidation, all on-chain), **build priority 2** (the $CREDIT price oracle) and the on-chain half of **build priority 3** (the agent's rate switch). The agent program itself is in `../agent`.

```
forge build
forge test              # unit + fuzz + invariant (16k randomized calls); no internet needed
FOUNDRY_PROFILE=fork forge test -vv   # on request: live-chain test against the real Orbio Exchange
ADMIN_MULTISIG=0x.. GUARDIAN=0x.. AGENT=0x.. forge script script/Deploy.s.sol --fork-url robinhood   # dry run
```

`test/fork/OrbioExchangeFork.t.sol` reads the live Orbio Exchange and needs internet access, so the normal `forge test` skips it (configured in `foundry.toml`).

## Contracts

| Contract | Role | Holds funds? |
|---|---|---|
| `CreditLendPool` | Lender deposits (ERC-4626 `cCREDIT`), collateral custody, borrow / repay / liquidate, interest accrual | **Yes, all of them** |
| `CollateralManager` | Per-asset LTV / liquidation threshold / bonus / supply cap; price routing | No |
| `KinkedInterestRateModel` | Utilization curve; immutable params | No |
| `LiquidationLogic` (library) | Health factor, close factor, seize math | No |
| `CreditPriceOracle` | $CREDIT settlement price from the Orbio order book, with circuit breakers; passes other assets to a base oracle | No |
| `FixedPriceOracle` | Immutable fixed prices. v1 oracle; now the base oracle for USDG = $1 | No |
| `RateController` | The agent's only on-chain power: switching between timelock-approved rate models, with a public delay | No |

Owner of the pool, CollateralManager and RateController = `TimelockController` (2-day delay). The guardian can only **pause** risk-increasing actions and **cancel** a pending rate switch. The agent can only **propose** a rate switch from the menu.

## Design decisions (agreed 2026-10-20 / 2026-10-21)

1. **Borrowed $CREDIT is consumed (decision A).** Once borrowed $CREDIT leaves the pool, it is fungible tokens in the borrower's wallet. Activation, selling and transferring can't be told apart on-chain, and each is final from the lender's view. So the pool doesn't try to detect activation. Lenders are protected only by overcollateralization plus permissionless liquidation. Liquidators repay with *market* $CREDIT, never "the same tokens". See `test_activation_lendersMadeWholeFromCollateral`.
2. **Debt is valued at the $1 face value for every health check.** This is the conservative choice for a debt asset, and it needs no oracle on the debt side. Liquidation seizures are sized with a separate *settlement price* from `CreditPriceOracle`, capped at $1. A liquidator buying discounted $CREDIT therefore receives collateral worth what they actually paid plus the bonus, not a windfall from the borrower.
3. **Interest accrues in $CREDIT** through a global borrow index. A 10% reserve factor builds a first-loss buffer. USDG or native-token rewards are a later, separate incentive layer.
4. **v1 collateral is USDG only.** ORBIO and other volatile assets need their own price feeds first.
5. **$1 is the ceiling and the emergency fallback, not a floor.** A $1 floor would pay liquidators as if $CREDIT were worth $1 while it trades around $0.55.
6. **No Uniswap price source (for now).** See the findings below.
7. **An unpriceable asset counts as $0** (lender-safe) instead of freezing the account.

## Can $CREDIT trade above $1? (verified 2026-10-21)

Sources: the verified source of the live contracts on Sourcify (OrbioCreditV5 implementation `0xe4ae…0ba5`, OrbioExchange implementation `0x2d25…fbb7`), plus live reads at block 94,159,369.

- **On Orbio's order book: no.** `PriceMath.isValid` rejects any sell order priced above 1 USDG per CREDIT.
- **Buyers pay a fee on top:** `feeBps` = 2% live, with a hard maximum of 10%. A buyer's all-in cost can reach $1.02 today, or $1.10 at most. A seller never receives more than $1.
- **Activation is worth less than $1:** `activationFeeBps` = 5% live, capped at 10%, so activating 1 CREDIT credits $0.95 of inference. This is the "5% fee" that secondary articles mention.
- **The token itself has no transfer restrictions**, so off-book trades above $1 are possible in principle. They would be irrational while the book sells at ≤ $1.02.
- **Market at the time:** cheapest ask $0.50. Buying 50,000 CREDIT averaged $0.537 plus the 2% fee. Every Uniswap pool priced it at $0.40–$0.76.
- **Caveat:** both contracts are upgradeable by Orbio. This describes today's code.

**Uniswap findings.** Uniswap v4 has 18 $CREDIT pools: none keeps price history, most are empty, and some charge fees of up to ~90%. Uniswap v3 has 1 pool (CREDIT/USDG 1%, `0x8C85…63c3`) holding about $10k, with price history switched off (observation cardinality 1). Uniswap v2 has none. That is too little liquidity for a manipulation-resistant price, and using it, even as a breaker trigger, would give attackers a cheap lever. Revisit if a deep pool with price history appears.

## How the $CREDIT price works (`CreditPriceOracle`)

The exchange keeps no price history, so the oracle takes its own readings. `update()` is permissionless and can be called once per 5 minutes. The agent will call it from priority 3.

1. **Reading:** the oracle asks the book what buying **5,000 CREDIT** costs right now, *including Orbio's buyer fee*. That is the real all-in cost a liquidator pays, so for liquidations up to about that size, the liquidator keeps the full 5% bonus even if Orbio raises its fee. Larger liquidations pay more per CREDIT; see limitations. The result is capped at $1.
2. **Circuit breakers:**
   - *Too soon:* readings must be at least 5 minutes apart.
   - *Incomplete:* if the book can't fill all 5,000, or the quote hits Orbio's 64-order limit, the reading is rejected.
   - *Divergent:* if a reading is more than 25% away from the **previous reading**, it is rejected. A matching reading 5 minutes later is accepted. This throws away one-off spikes, such as fake asks placed and cancelled in one transaction, while real moves get confirmed. Comparing reading-to-reading (rather than to our own average) means it can never lock the oracle onto a stale price.
   - *Speed limit:* the recorded price may fall at most **2% per hour**. Rises are not limited, up to $1. Faking a low price is free on this book; faking a high one costs real purchases.
   - *Stale:* if nothing has been recorded for **2 hours**, the price is **$1** until readings resume. They then resume from the **last good price** (old history cleared, still under the speed limit), not from $1.
3. **Price used by liquidations:** the time-weighted average of the last **hour** of recorded readings. This reads stored data only, never the live book, so nobody can move the book and liquidate in the same transaction.

**Warm-up (deployment only):** a brand-new oracle has no history, so it starts from $1 and comes down under the speed limit. From $1 to ~$0.55 takes about 30 hours. That is harmless in practice: new positions start well inside their limits and can't become unhealthy that fast. After an outage there is no warm-up; readings resume from the last good price.

## The agent's rate switch (`RateController`)

The spec lets the agent tune interest rates (§4.1, §8). It does so only through `RateController`, which the pool names as its `rateController`: the one address besides the timelock allowed to call `setInterestRateModel`.

1. **A fixed menu.** The timelock approves rate models in advance. The deploy script approves three:

   | Model | Base rate | Up to the kink | Kink | Above the kink | Max rate |
   |---|---|---|---|---|---|
   | Lower (attract borrowers) | 1% | +6% | 70% | +120% | 127% |
   | **Normal** (starts active) | 2% | +10% | 65% | +150% | 162% |
   | Higher (attract lenders) | 4% | +15% | 60% | +200% | 219% |

2. **Announced 6 hours ahead.** The agent proposes; anyone can execute once 6 hours have passed (within the following 24 hours, after which the proposal expires). Users see every rate change coming.
3. **At most one switch per 24 hours**, counted from the last executed switch. One proposal can be pending at a time.
4. **The guardian or timelock can cancel** a pending switch. If the timelock removes a model from the menu, a pending switch to it can no longer execute.
5. **No other power.** The agent can't touch funds, collateral rules, caps, prices or the menu. The timelock can still set any model directly, set a new agent, or unset the controller.

## Safety properties

- Internal accounting (`cash`, `totalCollateral`). Donations don't move prices, and together with a 6-decimal share offset this blocks ERC-4626 inflation attacks.
- Rounding always favors lenders: debt rounds up, and collateral paid out rounds down.
- `LTV < LT` and `LT × (1 + bonus) ≤ 100%` are enforced for every asset, so a liquidation at HF = 1 never creates bad debt.
- Close factor: 50% of debt per liquidation, or 100% when HF < 0.95 or debt ≤ `minDebt` (dust).
- Bad debt is written off once a borrower has no collateral left. Reserves absorb it first, and any remainder lowers the cCREDIT share price.
- Fee-on-transfer behavior is rejected (`_pullExact`), because CREDIT and USDG are both upgradeable proxies.
- Pausing never blocks repay, liquidate, lender withdrawals or collateral withdrawals. Only the timelocked owner can unpause.
- New borrows are rejected above 90% utilization, keeping a liquidity buffer for lenders.
- **Borrow caps** (`setBorrowCaps`, timelocked owner) limit debt per account and in total, so every position stays liquidatable at a profit on the thin $CREDIT book (see below). They block only *new* borrowing: interest may take a position above a cap, and repaying, withdrawing and liquidating are never blocked. Default is unlimited; the deploy script sets them.
- **One unpriceable asset can't freeze an account.** An asset whose price can't be read counts as $0. Borrowing and withdrawing are judged on the collateral that *can* be priced, and liquidators can seize any priceable collateral. Repay always works.
- Invariants fuzzed (`test/invariant`): cash and collateral fully backed, total borrows equal to the sum of account debts, no debt without collateral, and a share price that never drops unless bad debt is realized.

## Documented assumptions and known limitations

- **$CREDIT** (`0xe333…004c`): 6 decimals, a UUPS proxy (OrbioCreditV5). Orbio can upgrade it, and that trust assumption can't be removed. The pool never calls `activate`.
- **USDG** (6 decimals) is also an upgradeable proxy. There is no trustworthy on-chain USDG/USD feed, so USDG stays fixed at $1, and **the oracle can't see a USDG depeg.** The mitigation is the guardian pausing borrows and collateral deposits.
- **The oracle needs someone to call `update()`.** If nobody does for 2 hours, the price falls back to $1 *while the outage lasts*, and borrowers liquidated during it lose more than the market cost of their debt (lenders are unaffected). Once readings resume, the price returns to the last good price straight away.
- **Liquidation size vs. book depth (addressed with borrow caps; revisit regularly).** The settlement price reflects a 5,000-CREDIT purchase, and bigger purchases walk up the book. Liquidator margin by liquidation size, live book at block 94,212,109 (2026-10-21):

  | Size (CREDIT) | 5,000–12,500 | 15,000 | 20,000 | 25,000 | 30,000 | 40,000 |
  |---|---|---|---|---|---|---|
  | Margin | 5.0% | 4.6% | 2.6% | 1.1% | 0.1% | −1.1% |

  One purchase can't exceed ~55,000 CREDIT (64-order limit), and the whole book held ~202,000 CREDIT. **Launch caps** (`Deploy.s.sol`):
  - **20,000 CREDIT per account.** A typical liquidation closes half (10,000, 5% margin); a full close still earns ~2.6%.
  - **50,000 CREDIT in total**, about a quarter of the book, so even several positions failing together can be liquidated over a few hours as the oracle follows the book up.
  - **USDG collateral cap 200,000.** 50,000 CREDIT of debt needs at least ~71,500 USDG.

  The book changes daily. The timelock can raise the caps as it deepens, and the agent should track margin by size (priority 3).
- **Residual manipulation risk.** Anyone can place cheap sell orders and cancel them in the same transaction. Someone who wins *every* reading slot with consistent fake readings can still drag the recorded price down, by at most 2% per hour. The liquidator's margin within the reference size is ~5%, so a sustained attack of about 2.5 hours could make even small liquidations unprofitable until honest readings resume. The agent's monitoring (priority 3/6) must alert on this. A stronger defense (requiring a reading to be confirmed in a later block by a *different* caller's reading) is a possible follow-up.
- **When the price is $1 or near it,** Orbio's buyer fee can exceed the 5% liquidation bonus. If the fee were raised to its 10% maximum, liquidating near face value would be unprofitable.
- **Seizing an unpriceable asset itself is impossible.** If a borrower's *only* collateral is unpriceable, liquidation waits until its price returns.
- **`Deploy.s.sol` deploys `CreditPriceOracle`** (with a `FixedPriceOracle` holding only USDG = $1 as its base). After deployment someone must call `update()` about every 5 minutes. Until then, and for the ~30-hour warm-up, the $CREDIT settlement price sits at or near $1.
- After deployment, `CollateralManager` **and** `CreditLendPool` ownership are **pending** until the timelock executes `acceptOwnership()` on each. Until then the deployer still owns them. The deployer holds them only to list USDG and set the borrow caps in the same deployment.
- Not audited yet.

## Next (spec §9)

3. Agent program (`../agent`): keeps the oracle fed, watches positions, the book and the readings, and proposes rate switches through `RateController`.
4. Orbio launchpad funding.
