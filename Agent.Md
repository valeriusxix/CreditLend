# AGENT.md
## Orbio $CREDIT Collateralized Lending Market

**Project Name:** CreditLend (working title)  
**Chain:** Robinhood Chain (chain ID 4663)  
**Primary Asset:** $CREDIT (1 $CREDIT = $1 of Orbio inference)  
**Status:** Build specification for LLM agent  
**Updated 2026-10-22** to match the implementation after the security review (see `AUDIT.md`, findings H-2 and L-4). Changed lines say what the code actually does.  

---

## 1. Mission

Build a fully collateralized lending and borrowing market for Orbio $CREDIT.

- Lenders deposit $CREDIT and earn interest, paid in $CREDIT through the rising value of their cCREDIT shares.
- Borrowers deposit overcollateralization and borrow $CREDIT.
- An AI agent (funded by the Orbio agent launchpad) monitors the market, rebalances interest rates, and assists with liquidations.
- Critical safety logic (collateral accounting, health factor, liquidation math) must live on-chain and be deterministic.
- Activation of borrowed $CREDIT is treated as irreversible consumption and must be fully covered by collateral.

This is not a standard Aave-style pool. Activated $CREDIT is burned and cannot be returned.

---

## 2. Core Constraints (Non-Negotiable)

1. **Activation is permanent**  
   Calling `activate` on $CREDIT burns the token and credits non-transferable API balance. Once activated, principal is gone.

2. **Therefore:**
   - Borrowers must be overcollateralized.
   - Borrowed $CREDIT is treated as consumed the moment it leaves the pool. Activation can't be observed on-chain, and every wallet can activate, so no loan relies on the tokens coming back. Every loan is fully covered by collateral, with debt always valued at the $1 face value, and a position is liquidated when its health factor falls below 1.
   - Lenders must be made whole from collateral, not from the expectation that the same $CREDIT tokens return.

3. **Agent role**  
   The AI agent uses Orbio API credits (self-funded via launchpad fee routing) for:
   - Continuous monitoring
   - Interest rate optimization
   - Liquidation signaling / assistance
   - Rebalancing  
   Critical enforcement (health factor calculation, collateral seizure, repayment) must be on-chain.

4. **Pricing**  
   $CREDIT frequently trades at a significant discount to face value on the order book. Do not treat it as a hard $1 stable. Implemented as follows:
   - Health checks value debt at the $1 face value, the conservative ceiling.
   - Liquidations are sized at an order-book TWAP with circuit breakers (spike rejection and a 2%/hour fall limit), capped at $1.
   - USDG collateral is priced from Chainlink's USDG/USD feed, capped at $1.
   - A Uniswap second source for $CREDIT can be added once a liquid $CREDIT pool exists.

---

## 3. Key Contracts & Addresses (Robinhood Chain 4663)

| Asset / Contract     | Address                                      | Notes |
|----------------------|----------------------------------------------|-------|
| $CREDIT              | `0xe33322da1380e61e5ae5dfb21e7f62924c73004c` | 6 decimals. `activate(uint256)` burns into API balance |
| $ORBIO               | `0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3` | Staking asset |
| USDG                 | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` | Stable used on order book |
| Orbio Exchange       | `0x6951ffd32630b05e06f50062aea801625a58ebc0` | Order book (`buy`, `sell`, `buyAndActivate`) |
| Staking              | `0xe0710011278bfb63e57c5f227e5980984b1eddca` | Mints $CREDIT to stakers |

---

## 4. High-Level Architecture

### 4.1 Smart Contracts (On-chain)

- **CreditLendPool** (main market)
  - Accepts $CREDIT deposits from lenders → issues cCREDIT (or internal accounting).
  - Accepts collateral deposits from borrowers.
  - Tracks borrows, interest, and health factors.
  - Exposes `borrow`, `repay`, `liquidate`, `withdraw`.

- **CollateralManager**
  - Supports USDG at launch; ORBIO or other liquid assets once a trustworthy price feed exists for them.
  - Configurable LTV, liquidation threshold, liquidation bonus per asset.
  - Price oracle interface.

- **InterestRateModel**
  - Utilization-based (similar to Aave kinked model).
  - Can be updated by the agent or a timelocked admin.

- **LiquidationEngine**
  - Calculates health factor.
  - Allows anyone (or the agent) to liquidate undercollateralized positions (borrowed $CREDIT counts as consumed from the start).
  - Seizes collateral + bonus and repays the $CREDIT debt.

- **AgentVault / Role**
  - Separate role or contract that the Orbio-funded agent can call for non-critical actions (rate updates, signaling).
  - Cannot arbitrarily seize funds.

### 4.2 AI Agent Layer

- Agent is launched via **Orbio Agent Launchpad**.
- Creator fees from its token are routed roughly as:
  - ~50% staked as $ORBIO (continues earning $CREDIT)
  - ~30% minted as $CREDIT
  - ~10% direct API balance
  - ~10% treasury
- Agent uses its Orbio API key / gateway balance to:
  - Poll positions and prices
  - Decide rate adjustments
  - Call liquidation or signaling functions
  - Generate reports / alerts
- Prefer MCP / SDK / OpenAI-compatible client pointed at Orbio gateway.

### 4.3 Frontend / Interface
- Simple deposit / borrow / repay / liquidate UI.
- Display health factors, utilization, rates, and available liquidity.
- Wallet connection on Robinhood Chain.

---

## 5. Economic Parameters (Starting Recommendations)

| Parameter                    | Suggested Starting Value | Notes |
|-----------------------------|--------------------------|-------|
| Max LTV (USDG)              | 70–75%                   | Conservative |
| Liquidation Threshold       | 80–85%                   | |
| Liquidation Bonus           | 5–8%                     | |
| Min collateral factor       | High                     | Start tight |
| Interest model              | Kinked utilization       | Low base, steeper above 60–70% util |
| Price safety margin         | Debt at $1 face value (above the book price) in health checks | Stricter than a 10–20% margin; liquidations sized at the book TWAP |
| Borrow activation policy    | Treat all borrowed $CREDIT as consumed from the start | Full collateral coverage; liquidation when HF < 1 |

Adjust after real usage data.

---

## 6. Key User Flows

### Lender
1. Approve and deposit $CREDIT.
2. Earn interest (accrued continuously or per block).
3. Withdraw principal + interest (subject to utilization / available liquidity).

### Borrower
1. Deposit collateral (USDG / ORBIO / etc.).
2. Borrow $CREDIT up to LTV.
3. Use or activate the $CREDIT (it counts as consumed from the start, so activating changes nothing on-chain).
4. Repay $CREDIT + interest to unlock collateral.
5. Or get liquidated if the health factor drops below 1.

### Liquidator / Agent
1. Monitor health factors.
2. Call liquidate when conditions are met.
3. Receive collateral bonus.

### Agent Operational Loop
1. Check its own Orbio balance / $CREDIT.
2. Fetch market state (utilization, rates, unhealthy positions).
3. Decide and execute rate updates or liquidation calls.
4. Log actions and regenerate context as needed.

---

## 7. Launch & Funding Path

1. Deploy core contracts on Robinhood Chain.
2. Launch the managing agent’s token via Orbio Agent Launchpad (paired with $ORBIO).
3. Configure the agent wallet so creator fees flow into the agent’s Orbio account.
4. Agent uses the resulting $CREDIT / API balance to operate.
5. Optionally pair the project token with $CREDIT in a fee-bearing pool for additional agent funding.

---

## 8. Risks & Mitigations (Must Address in Code & Docs)

| Risk                          | Mitigation |
|-------------------------------|------------|
| Activation of borrowed $CREDIT | Treated as consumed from the start: full collateral coverage at the $1 face value |
| Thin $CREDIT liquidity        | Conservative LTV, price buffers, utilization caps |
| Agent downtime / bad decisions| On-chain enforcement of critical paths; agent is assistive |
| Oracle manipulation           | Order-book TWAP with circuit breakers for $CREDIT (debt at $1 for health); Chainlink for USDG |
| Interest rate gaming          | Kinked model + admin/agent update delays |
| Launchpad fee volatility      | Agent should be able to operate with modest compute; have fallback funding |

---

## 9. Build Priorities (Suggested Order)

1. Core pool + collateral + basic interest accrual + liquidation (on-chain only).
2. Price oracle (order book + Uniswap).
3. Agent role + rate update function.
4. Orbio launchpad integration and agent funding flow.
5. Frontend.
6. Monitoring, alerts, and agent prompt/system refinements.
7. Parameter tuning based on testnet / early mainnet data.

---

## 10. Success Metrics

- Lenders can deposit and withdraw $CREDIT + interest without principal loss under normal conditions.
- Borrowers can access $CREDIT against collateral.
- Liquidations successfully cover debt when positions become unhealthy.
- Agent can operate for extended periods using self-generated Orbio credits.
- Market generates real utilization and fees rather than pure token speculation.

---

## 11. Additional Notes for the Implementing LLM

- Always prioritize lender safety over feature velocity.
- Document every assumption about $CREDIT activation behavior.
- Prefer transparent, auditable contracts.
- The AI agent is a feature and narrative advantage, not a substitute for correct on-chain accounting.
- Reference official Orbio docs for the latest fee splits and contract ABIs, as they have evolved.

**End of specification.**  
Use this document as the single source of truth when designing, coding, and iterating on the CreditLend market.