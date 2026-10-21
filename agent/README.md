# CreditLend agent

The off-chain half of build priority 3 (spec §4.2, §6 "Agent Operational Loop"). It is **assistive**: every safety rule lives in the contracts, and the market keeps working if the agent stops. The agent makes it run better: a fresh price, fast liquidations and early warnings.

```
cd agent
npm install
cp .env.example .env      # then fill it in
npm test                  # 51 tests, no network
npm run once              # one check, then exit
npm start                 # run forever (one check a minute)
```

## What it does

| How often | Job | Needs |
|---|---|---|
| Hourly, or **every 5 minutes** when anything looks off | Takes a `$CREDIT` price reading (`CreditPriceOracle.update()`) | wallet with gas |
| Every minute | Checks every borrower's health; warns below 1.10; liquidates below 1.00 (optional) | wallet + USDG float to liquidate |
| Every minute | Watches for price manipulation (others posting low readings, many rejected readings, recorded price below the live book) | nothing |
| Hourly | Measures liquidator profit by size on the live order book and warns if the borrow caps are too big for it | nothing |
| As soon as allowed | Executes a pending rate switch once its 6-hour notice has passed | wallet with gas |
| Daily | AI review via the Orbio gateway: a short report and a rate recommendation | `ORBIO_API_KEY` |

Without a wallet (`AGENT_PRIVATE_KEY` empty) it runs **read-only**: monitoring and alerts only, no transactions.

### The reading schedule

Every 5 minutes nonstop costs about **$77/month** in gas (179,000 gas per reading; measured 2026-10-21 at 0.02 gwei and ETH $2,467). Hourly costs about **$7/month**. The agent reads hourly while things are calm and switches to **every 5 minutes** as soon as any of these is true:

- someone else took a reading in the last hour (the oracle is contested);
- a reading in the last hour was rejected (it needs a confirming reading 5 minutes later);
- its own last attempt failed;
- the oracle is stale;
- the recorded price is more than 3% from the live book;
- any position is below health 1.10.

Hourly isn't as strong as every 5 minutes against someone posting fake low readings, because they would get the empty slots. That is why any reading by someone else immediately switches the agent to every 5 minutes. Expect **about $7–15/month**. Before each reading the agent dry-runs it, so a reading that would be rejected as "too soon" costs nothing.

### Auto-liquidation (off by default)

Set `LIQUIDATOR_ENABLED=true` and send the agent's wallet a **USDG float** (about 6,000 USDG covers a typical liquidation at today's caps and prices). For an unhealthy position it:

1. works out the largest repayment the pool allows (50%, or 100% below health 0.95);
2. buys that much `$CREDIT` on the Orbio book, using any `$CREDIT` it already holds first;
3. repays it and receives the collateral plus the 5% bonus.

It only goes ahead if it would earn at least `LIQUIDATOR_MIN_PROFIT_BPS` (default 1%) **after** the purchase and Orbio's fee. That floor is also sent to the pool as `minSeized`, so the chain refuses a loss-making liquidation even if prices move in between.

One known risk: if someone else liquidates the same position between the purchase and the liquidation, the agent is left holding `$CREDIT`. It uses that stock first next time.

### The daily AI review

Once a day the agent sends a plain-text market snapshot to the model `AGENT_MODEL` (default `anthropic/claude-opus-5.5`, Orbio's name for Claude Opus 5.5) through the Orbio gateway, paid from the Orbio API balance (about $0.05 a day). The agent reads `agent/.env`, not the project's root `.env`, so copy `ORBIO_API_KEY` and `ANTHROPIC_BASE_URL` across. **Not yet tested against the live gateway**: run `npm run once` with the key set and check the log for the daily report. The model replies with a short report and one of `lower` / `normal` / `higher` / `keep`.

**The AI only advises.** Plain code then applies strict rules:
- any malformed answer means no action;
- only one step at a time (lower ↔ normal ↔ higher);
- nothing while a switch is pending or within 24 hours of the last one.

The contract enforces the rest: approved menu only, 6 hours' public notice, guardian can cancel. Proposals are only sent if `RATE_PROPOSALS_ENABLED=true`. Otherwise the report says what it *would* have proposed.

### Alerts

Alerts always go to the log. To also get them in a chat, set `ALERT_WEBHOOK_URL` (a Discord or Slack incoming webhook) and/or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`. The same alert repeats at most once an hour.

## Setting it up

1. **Wallet:** create a new wallet used only by the agent, and fund it with a little ETH for gas. Never reuse a wallet that holds anything else.
2. **Make it the agent:** pass its address as `AGENT=` when deploying (`contracts/script/Deploy.s.sol`), or have the timelock call `RateController.setAgent` later.
3. **Hosting:** any always-on machine with Node 22+. A small cloud server (about $5/month) is recommended. Run it under a process manager (for example `pm2` or a systemd service) so it restarts after crashes and reboots.
4. **Start read-only first:** leave `AGENT_PRIVATE_KEY` empty, run `npm run once` and check the log. Then add the key.

## Files

| File | Role |
|---|---|
| `src/keeper.js` | The loop: what runs when |
| `src/schedule.js` | When to take a reading (hourly vs every 5 minutes) |
| `src/risk.js` | Liquidation math, mirroring `LiquidationLogic.sol` |
| `src/liquidator.js` | Plan and execute a liquidation |
| `src/monitors.js` | Order-book depth and manipulation checks |
| `src/review.js` | Daily AI review and the rules that gate its recommendation |
| `src/alerts.js` | Log, webhook and Telegram alerts |
| `src/chain.js` | Every blockchain read and write (viem) |
| `src/config.js`, `src/abis.js`, `src/index.js` | Settings, contract interfaces, entry point |
