# CreditLend: hostile security review

**Scope:** every contract in `contracts/src` (CreditLendPool, CollateralManager, KinkedInterestRateModel, RateController, CreditPriceOracle, FixedPriceOracle, LiquidationLogic, interfaces) and `contracts/script/Deploy.s.sol`, checked against `Agent.Md`.
**Date:** 2026-10-22. Branch `audit/hostile-review`. **Nothing was fixed.**

**How findings were proven:** every finding below has a Foundry test in [`contracts/audit/AuditPoC.t.sol`](contracts/audit/AuditPoC.t.sol) that **passes while the weakness exists** (it asserts the bad outcome). They are kept out of the normal suite so the suite stays green. To run them:

```
cd contracts
cp audit/AuditPoC.t.sol test/ && forge test --match-path test/AuditPoC.t.sol -vv && rm test/AuditPoC.t.sol
```

Result on 2026-10-22: **9 passed, 0 failed** (8 findings, plus one control test).

## Summary

| ID | Severity | Finding | Who loses |
|---|---|---|---|
| — | **Critical** | **None found.** No way for an outsider to borrow without enough collateral or to take lender principal under the deployed configuration | — |
| H-1 | **High** | The owner can drain lenders through `CollateralManager.setOracle`, and right after deployment that owner is the deployer's hot key, not the timelock | Lenders, up to 90% of principal |
| H-2 | **High** (spec) | Activating borrowed $CREDIT does not trigger liquidation, which AGENT.md calls non-negotiable | Spec compliance; economic impact limited (see text) |
| M-1 | **Medium** | Anyone can force the $CREDIT oracle stale by interleaving fake readings; the settlement price then snaps to $1 and borrowers are over-liquidated | Borrowers being liquidated |
| M-2 | **Medium** | One atom of collateral, sent by anyone, stops bad debt from being written off; the first lender out escapes the loss and the last pays it | The last lenders out |
| M-3 | **Medium** | USDG is priced at a hard-coded $1 forever, so a depeg is invisible; the oracle is single-source, against AGENT.md §2.4 and §8 | Lenders, if USDG depegs |
| L-1 | Low | Interest on `totalBorrows` rounds down on every accrual; frequent calls to the public `accrueInterest()` stop lenders' share price rising in a small market | Lenders' timing of interest; reserves |
| L-2 | Low | Repaying can leave debt far below `minDebt` (dust nobody will ever liquidate) | Lenders, slowly |
| L-3 | Low | Liquidation pay lags the market (1-hour average, 2%/hour fall limit) | Borrowers in a crash; lenders in a rally |
| L-4 | Low (spec) | Smaller disagreements with AGENT.md (interest currency, ORBIO collateral, price safety margin) | — |

Things that were hunted for and **not** found are listed at the end, so you can see the coverage, not just the hits.

---

## High

### H-1: The owner can drain lenders through `setOracle`, and right after deployment the owner is the deployer's hot key

**In plain English:** the CollateralManager trusts whatever price oracle its owner points it at, with no limits. Point it at an oracle that says one cent of USDG is worth a billion dollars, and anyone can borrow every $CREDIT the pool will lend against almost nothing.

The owner is meant to be a 2-day timelock, so lenders would see it coming. But `Deploy.s.sol` uses `transferOwnership`, which in OpenZeppelin's `Ownable2Step` only makes the timelock the *pending* owner. **Until the timelock schedules and executes `acceptOwnership()` (at least 2 days, and only if someone remembers), the deployer's ordinary wallet is the real owner.** The same applies to the pool itself (`setInterestRateModel`, `reduceReserves`, `skim`, caps).

Even after the timelock takes over, a compromised admin multisig can do the same thing with 2 days' notice. Lenders can't all leave in time, because up to 90% of their $CREDIT may be lent out (the utilization cap is 90%).

- Code: `CollateralManager.setOracle` (no bounds on prices); `Deploy.s.sol` lines 120 and 151 (`transferOwnership`, pending only).
- Impact: up to 90% of lender principal in one transaction.
- Likelihood: needs the deployer key (during the window) or the admin multisig (after it).

**Test:** `test_H1_ownerCanDrainLendersThroughSetOracle_evenWithOwnershipPending`
1. A lender deposits 100,000 CREDIT.
2. The owner calls `transferOwnership(timelock)`; the test checks that the owner hasn't changed yet.
3. The still-owner sets an oracle pricing USDG at 1e33.
4. The attacker posts **1 atom** of USDG and borrows 90,000 CREDIT.
5. The lender can now withdraw only 10,000.

### H-2: Activating borrowed $CREDIT does not trigger liquidation (AGENT.md §2 "Non-Negotiable", §5, §8, §10)

**In plain English:** the spec says that if a borrower burns their borrowed $CREDIT into API balance ("activation"), their position must be liquidated in full immediately. The contracts never look for activation. A borrower who activates everything keeps a perfectly "healthy" position, and liquidators are refused.

The code documents this as a deliberate choice ("decision A" in `CreditLendPool` and `ICredit`). Borrowed tokens are treated as spent the moment they leave the pool, and lenders are protected only by over-collateralization. Debt is valued at $1 per CREDIT, which is above its market price, and borrowing stops at 70% of collateral. So the *economic* risk is much smaller than the spec implies. **But it plainly contradicts a rule the spec calls non-negotiable, and AGENT.md §10's success metric ("liquidations cover debt when $CREDIT is activated") is not met.** Either the code or the spec needs to change.

**Test:** `test_H2_activationOfBorrowedCredit_doesNotTriggerLiquidation`
1. The borrower borrows 500 CREDIT and calls `credit.activate(500)`.
2. The health factor is still at least 1.
3. `liquidate` reverts with `PositionHealthy`.

---

## Medium

### M-1: Anyone can force the oracle stale; the settlement price then snaps to $1 and borrowers are over-liquidated

**In plain English:** the $CREDIT price oracle rejects any reading more than 25% away from the *previous reading*, accepted or not, to filter out one-off spikes. On the Orbio book a fake ask can be placed, read and cancelled in one transaction for the price of gas.

An attacker who inserts a fake reading between honest ones makes **every** reading look like a spike:
- the honest one diverges from the fake one before it;
- the next fake one diverges from the honest one.

Nothing is recorded. After 2 hours the oracle counts as stale and returns its fallback, $1, while the market is at $0.55. Liquidations are then sized at $1: a liquidator receives about 1.8 times the collateral they should (USDG worth $1.05 for each CREDIT costing $0.55), all of it taken from the borrower.

The README already lists a slower "drag the price down 2%/hour" attack. This "force it stale" variant is cheaper, since it needs only every *other* slot, and isn't documented. Lenders are not harmed (a $1 price over-pays liquidators); borrowers are.

- Code: `CreditPriceOracle.update` (divergence compared with `lastRawPrice`, which rejected readings overwrite); `getPrice` (stale means `FACE_VALUE`).
- Mitigating: positions must already be below health 1 to be liquidated.

**Test:** `test_M1_attackerForcesOracleStale_settlementSnapsToOneDollar`
1. 40 hours of honest $0.55 readings.
2. 30 slots alternating attacker $0.10 and honest $0.55: **0 accepted**, the oracle is stale, and `getPrice` returns $1.
3. Wired into the market, a liquidation of 350 CREDIT seizes **432.4 USDG instead of 237.8**.

### M-2: One atom of collateral stops bad debt from being written off; the first lender out escapes, the last one pays

**In plain English:** when a position is underwater and a liquidation takes its last collateral, the pool writes off the leftover debt, so all lenders share the loss at once. But the write-off only happens if the borrower has **no collateral of any kind** left (`_hasCollateral`).

Anyone can deposit collateral *on behalf of* anyone (`depositCollateral(asset, amount, onBehalfOf)`). One atom of a second listed asset, sent just before the liquidation, keeps the borrower "collateralized". The unrecoverable debt then stays on the books, and the pool keeps counting it as a lender asset. A lender who knows this redeems at full value, and the loss lands entirely on whoever is left.

There is no admin function to write off debt, so it stays hidden until someone liquidates the dust. Nobody is paid to do that.

- Code: `CreditLendPool.liquidate` (`if (remaining > 0 && !_hasCollateral(borrower)) _realizeBadDebt(...)`), `_hasCollateral`, `depositCollateral` (`onBehalfOf`).
- Precondition: an underwater position (collateral worth less than the debt), and a second listed collateral asset or simply a leftover atom of the first.

**Test:** `test_M2_dustCollateralHidesBadDebt_firstLenderOutEscapes`
1. Two lenders deposit 1,000 each; a borrower borrows 700 against 1,000 USDG; USDG falls to $0.50.
2. The first lender sends the borrower 1 wei of ORBIO; the liquidation then takes all the USDG.
3. **223.8 CREDIT of uncollectable debt remains**, and the first lender redeems the full 1,000.
4. The second lender's claim of 1,000 includes the 223.8 that will never be paid.

**Control:** `test_M2_control_withoutDust_badDebtIsWrittenOffAndShared` runs the same scenario without the dust. The debt is written off, and the first lender gets back under 900.

### M-3: USDG is priced at a hard-coded $1 forever; the price feed is single-source

**In plain English:** USDG, the only collateral, is priced by `FixedPriceOracle` at exactly $1, with no way to change it.
- **If USDG depegs**, say to $0.40, nothing on-chain notices. Anyone can buy cheap USDG, borrow 70% of its *face* value in $CREDIT, and walk away. Lenders keep the worthless collateral.
- **The only defence** is the guardian pausing new borrowing by hand.
- **Against the spec:** AGENT.md §2.4 asks for "order book TWAP + Uniswap + face-value floor with safety margin", and §8 for "multi-source pricing + circuit breakers". The $CREDIT side uses only the Orbio order book; the USDG side uses nothing at all.

- Code: `FixedPriceOracle` (immutable), `Deploy.s.sol` (USDG fixed at 1e18), `CreditPriceOracle` (single source).

**Test:** `test_M3_fixedUsdgPrice_cannotSeeADepeg`
- With the deployed `FixedPriceOracle`, an attacker borrows 699 CREDIT against 1,000 USDG.
- The test asserts the oracle still reports $1 and the health factor stays above 1, whatever USDG trades at.
- A real depeg can't be simulated, because the price can't be changed; that is the finding.

---

## Low

### L-1: Interest on `totalBorrows` rounds down on every accrual; anyone can call `accrueInterest()` every second

**In plain English:**
- Each accrual adds `totalBorrows × rate × seconds`, rounded down to whole atoms.
- In a small market, one second of interest is less than one atom, so it rounds to zero every time.
- `accrueInterest()` is public, and every user action calls it.
- Accrued every second, the pool's total debt never grows, while each borrower's own debt (tracked separately through `borrowIndex`, which keeps 18 decimals) does.

The effects:
- lenders' share price stands still;
- the protocol's reserves earn nothing;
- utilization reads low, so the rate model under-charges.

The missing interest only appears later, in one jump, when borrowers repay. Someone who deposits just before a large repayment captures part of it.

- Code: `CreditLendPool._pendingAccrual` (`interest = totalBorrows.mulDiv(factor, WAD)`, floor).
- Severity Low: it bites only in small markets or under constant spamming (about 50,000 gas per call, roughly $9/hour at today's gas). The money is delayed and redistributed, not destroyed.

**Test:** `test_L1_frequentAccrual_suppressesLenderInterest`
1. 50 CREDIT borrowed from 100 lent; `accrueInterest()` called every second for an hour.
2. `totalBorrows` and `totalAssets` are unchanged, while `debtOf(borrower)` has grown.

### L-2: Repaying can leave debt far below `minDebt`

**In plain English:** the minimum loan size (10 CREDIT) is enforced only when borrowing. A borrower can repay down to a single atom of debt. Positions like that cost more gas to liquidate than they could ever pay. If one goes bad, nobody will clean it up, and its interest keeps inflating the lenders' books (see L-1 and M-2).

- Code: `CreditLendPool.repay` / `_reduceDebt` (no minimum check).

**Test:** `test_L2_repayLeavesDustBelowMinDebt`
1. The borrower borrows 10 CREDIT and repays 10 CREDIT minus 1 atom.
2. The remaining debt is 1 atom, below `minDebt`.

### L-3: Liquidation pay lags the market

**In plain English:** liquidators are paid using a 1-hour average price that may fall at most 2% per hour.
- **If $CREDIT crashes**, say from $0.55 to $0.30 in a day, liquidations are still sized near $0.55 for many hours. Liquidators get a windfall at the borrower's expense.
- **If $CREDIT rallies**, liquidators pay the new market price but are paid at the old, lower average. Liquidating loses money and stalls, which delays lender protection.

This is the designed trade-off (the README documents the speed limit), but it is a real exposure.

- Code: `CreditPriceOracle` (`twapWindow`, `maxDropBpsPerHour`), `CollateralManager.getDebtSettlementPrice`.
**Test:** `test_L3_liquidationPayLagsACrash`
1. Converge at $0.55, then take an honest $0.30 reading every 5 minutes for 6 hours.
2. The settlement price is still **$0.493**, so a liquidator buying at $0.30 is paid 1.64 times what the market justifies, from the borrower's collateral.

### L-4: Smaller disagreements with AGENT.md

| AGENT.md says | The code does | Note |
|---|---|---|
| §1: lender interest "paid in USDG or the project's native token" | Interest is paid in $CREDIT, through the cCREDIT share price | Simpler and safe, but different |
| §4.1 / §6: collateral "USDG, ORBIO, …" | Only USDG is listed (`Deploy.s.sol`); no ORBIO price source exists | ORBIO would need its own oracle first |
| §5: "price safety margin 10–20% below book price" | No margin. Health checks value debt at $1, which is stricter than the book; liquidations use the book average exactly | Arguably more conservative for health, less for seizure |
| §4.1 InterestRateModel "updated by the agent" | The agent can only *propose* one of three timelock-approved models, with 6 hours' notice | Safer than the spec; flagged only for completeness |

**Test:** none needed; these are visible by reading `Deploy.s.sol` and `CreditLendPool`.

---

## Hunted for and not found

| Area | What was checked | Result |
|---|---|---|
| **Borrowing without enough collateral** | `borrow` checks borrow power *after* updating debt; `withdrawCollateral` re-checks; collateral value rounds down, debt rounds up; borrowing $CREDIT against $CREDIT is refused | No path found with honest prices (H-1 and M-3 need a bad price) |
| **Lender share inflation / donation** | ERC-4626 with internal `cash` accounting and a 6-decimal virtual offset; donations are ignored and only `skim`-able | Not exploitable |
| **Reentrancy** | Every state-changing pool function is `nonReentrant`; oracle and price calls are view calls (STATICCALL); `liquidate` updates state before transfers; `_pullExact` rejects fee-on-transfer tokens | None found. CREDIT and USDG are upgradeable by their issuers, so a future hook is a trust assumption, not a bug |
| **Liquidation blocked or broken** | Close factor and dust rule; collateral shortfall path (scales the repayment down, rounds against the liquidator); an unpriceable sliver can't freeze an account (existing `UnpriceableCollateral.t.sol`); pausing never covers repay, withdraw or liquidate | Only M-2 (write-off skipped) and L-3 (pay lags) |
| **Phantom debt** (`totalBorrows` above the sum of real debts) | Per-account debt rounds up, total rounds down; `_reduceDebt` saturates | The sum of debts is always at least the total, so there are no phantom lender assets from rounding (the opposite of L-1) |
| **Access control** | `setInterestRateModel` (owner or RateController); RateController can only pick approved models, after a delay, and the guardian can cancel; the guardian can pause but not unpause; the agent has no role on the pool or CollateralManager | No holes beyond the owner's own power (H-1) |
| **Same-block oracle manipulation** | `getPrice` uses stored readings only; one reading at most per 5 minutes; a reading's fall is limited | Not possible in one transaction; slow attacks covered in M-1 and the README |
| **Gas griefing of `tryCollateralValue`** | The 63/64 rule could starve the price call | Not practical: the oracle calls cost a few thousand gas, far below what would starve the rest of the transaction |
| **Interest model** | No division by zero (`0 < kink < 1`); rate capped at 1000% APR, also capped in the pool | Fine. A malicious model set by the owner could revert and freeze accrual (owner trust, see H-1) |

## Trust assumptions (not bugs, but worth knowing)
- **Issuer upgrades:** $CREDIT, USDG and the Orbio exchange are upgradeable by their issuers. A malicious upgrade (blacklisting the pool, transfer fees, a fake quote) is outside the contracts' control.
- **The guardian:** one key that can pause new activity. If it is lost, only the timelock can pause.
- **Agent downtime:** if the agent stops, the oracle goes stale and falls back to $1 within 2 hours (see M-1 for what that does to borrowers).
