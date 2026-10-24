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

Pages have clean addresses (React Router; old `/#app` links redirect automatically):
- `/app`: lend, collateral, borrow and repay, with your health factor;
- `/app/liquidate`: every open position, riskiest first, with a liquidate button;
- `/app/account/0x…`: anyone's position (also reachable from the search button);
- `/docs`: plain-English protocol docs.

Because these are real paths, the web host must send every path to `index.html`. `render.yaml` (Render), `vercel.json` (Vercel) and `public/_redirects` (Netlify) already do this. For any other host, add the equivalent "single-page app" rewrite.

**Hosting on Render:** New > Blueprint > this repository. `render.yaml` sets the build (`npm ci && npm run build`, Node 24, publish `dist/`), the rewrite, and the mainnet `VITE_POOL_ADDRESS` / `VITE_POOL_DEPLOY_BLOCK`. Add `VITE_RPC_URL` (and backups) in the site's Environment tab. `VITE_` values are baked in at build time, so changing one needs a new deploy.

**How it talks to the chain:**
- **Reads** come straight from Robinhood Chain, so the market is visible without a wallet.
  - **Main server:** `VITE_RPC_URL`. Recommended: a dedicated provider such as Alchemy, with the key restricted to your domain.
  - **Backups:** `VITE_RPC_FALLBACK_URLS`, tried automatically if the main one fails.
  - **Last resort:** Robinhood's public server, always.
  - Visitors only see "Could not reach Robinhood Chain" if every server fails.
- **Transactions** go through the visitor's browser wallet. "Connect wallet" lists every wallet installed in the browser (MetaMask, Rabby, Coinbase Wallet, Phantom…, via the EIP-6963 standard) to pick one. On a phone, it offers to open the page inside the MetaMask or Coinbase Wallet app. The app then switches the wallet to Robinhood Chain (chain 4663), adding the network if the wallet doesn't know it, and reconnects to the same wallet on reload until you press Disconnect.
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

With `VITE_DEV_RPC` set, the wallet picker also offers **Local test account**, which uses anvil's unlocked test accounts. Add `?dev_account=N` to the URL to pick one. Real wallets can connect there too, but they **cannot send transactions** on a local copy: they would go to the real chain, where the local contract addresses mean nothing. All of this exists only in `npm run dev` and is stripped from `npm run build`.
