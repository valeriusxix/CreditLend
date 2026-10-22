# CreditLend

A fully collateralized $CREDIT lending market on Robinhood Chain. `Agent.Md` is the spec.

| Folder | What it is |
|---|---|
| `contracts/` | The on-chain market (Foundry): pool, collateral, interest, liquidation, price oracle, rate controller |
| `agent/` | The off-chain agent: price readings, position monitoring, liquidations, daily review, launchpad funding |
| `src/` | The website and app (React + Vite + viem) |

## The app

```
npm install
cp .env.example .env.local   # set VITE_POOL_ADDRESS (and VITE_POOL_DEPLOY_BLOCK) once deployed
npm run dev                  # http://localhost:5173
npm test                     # frontend math/format tests (no network)
npm run lint
npm run build                # static site in dist/, host it anywhere
```

Pages are chosen by the URL after `#`:
- `#app`: lend, collateral, borrow and repay, with your health factor;
- `#app/liquidate`: every open position, riskiest first, with a liquidate button;
- `#app/account/0x…`: anyone's position (also reachable from the search button);
- `#docs`: plain-English protocol docs.

**How it talks to the chain:**
- **Reads** go straight to Robinhood Chain's public RPC, so the market is visible without a wallet.
- **Transactions** go through the visitor's browser wallet (MetaMask, Rabby, Coinbase Wallet…). The app offers to switch the wallet to Robinhood Chain (chain 4663), and adds the network if the wallet doesn't know it.
- **Before asking for a signature**, every action is dry-run, so a transaction that would fail is explained in plain English instead.
- **Approvals** are for the exact amount, never unlimited.

**Until the contracts are deployed** and `VITE_POOL_ADDRESS` is set, the app says so instead of showing a market.

**ABIs** in `src/abi/` are copied from the compiled contracts. After changing a contract, run:

```
cd contracts && forge build && cd .. && npm run abis
```

### Testing against a local copy of the chain

`anvil --fork-url https://rpc.mainnet.chain.robinhood.com` starts a private copy of Robinhood Chain. Deploy to it with `--rpc-url http://127.0.0.1:8545 --broadcast` and anvil's test keys. Then run the app with:

```
VITE_POOL_ADDRESS=… VITE_RPC_URL=http://127.0.0.1:8545 VITE_DEV_RPC=http://127.0.0.1:8545 npm run dev
```

With `VITE_DEV_RPC` set, the app uses anvil's unlocked test accounts instead of a browser wallet. Add `?dev_account=N` to the URL to pick one. This exists only in `npm run dev` and is stripped from `npm run build`.
