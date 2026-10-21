// Every blockchain read and write the agent makes, in one place. The keeper only talks to this adapter,
// so tests replace it with a fake and never touch the network.
import { createPublicClient, createWalletClient, defineChain, http, BaseError, ContractFunctionRevertedError } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { poolAbi, collateralManagerAbi, oracleAbi, rateControllerAbi, rateModelAbi, exchangeAbi, erc20Abi, READING_STATUS, MAX_FILLS } from './abis.js'

export function robinhoodChain(rpcUrl) {
  return defineChain({
    id: 4663,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
}

/// Name of the custom error a contract call reverted with (e.g. "TooSoon"), or null. viem keeps it on a
/// nested error, not in the short message.
export function revertName(err) {
  if (!(err instanceof BaseError)) return null
  const inner = err.walk((e) => e instanceof ContractFunctionRevertedError)
  return inner?.data?.errorName ?? null
}

// eth_getLogs on this RPC accepts at most ~10M blocks per call with an address filter.
const LOG_CHUNK = 5_000_000n

export class ChainAdapter {
  constructor(cfg) {
    this.cfg = cfg
    const chain = robinhoodChain(cfg.rpcUrl)
    this.client = createPublicClient({ chain, transport: http(cfg.rpcUrl) })
    this.account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : null
    this.wallet = this.account ? createWalletClient({ chain, transport: http(cfg.rpcUrl), account: this.account }) : null
    this.address = this.account?.address ?? null
    this._txFrom = new Map()
  }

  _read(address, abi, functionName, args = []) {
    return this.client.readContract({ address, abi, functionName, args })
  }

  async _write(address, abi, functionName, args = []) {
    if (!this.wallet) throw new Error('no AGENT_PRIVATE_KEY: read-only mode')
    const { request } = await this.client.simulateContract({ address, abi, functionName, args, account: this.account })
    const hash = await this.wallet.writeContract(request)
    const receipt = await this.client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted in ${hash}`)
    return { hash, receipt }
  }

  async init() {
    const c = this.cfg
    this.collateralManager = await this._read(c.pool, poolAbi, 'collateralManager')
    this.minInterval = await this._read(c.oracle, oracleAbi, 'minInterval')
    this.referenceSize = await this._read(c.oracle, oracleAbi, 'referenceSize')
    const oracleCredit = await this._read(c.oracle, oracleAbi, 'credit')
    if (oracleCredit.toLowerCase() !== c.credit.toLowerCase()) throw new Error('oracle is not for $CREDIT')
  }

  /// Average blocks per hour over the last 100,000 blocks (used to size log look-backs).
  async blocksPerHour() {
    const latest = await this.client.getBlock({ blockTag: 'latest' })
    const past = await this.client.getBlock({ blockNumber: latest.number > 100_000n ? latest.number - 100_000n : 0n })
    const seconds = Number(latest.timestamp - past.timestamp) || 1
    return BigInt(Math.ceil((Number(latest.number - past.number) * 3600) / seconds))
  }

  async now() {
    const block = await this.client.getBlock({ blockTag: 'latest' })
    return { time: Number(block.timestamp), number: block.number }
  }

  // ---------------------------------------------------------------- oracle

  async oracleState() {
    const c = this.cfg
    const [lastReadingTime, fresh, recordedPrice] = await Promise.all([
      this._read(c.oracle, oracleAbi, 'lastReadingTime'),
      this._read(c.oracle, oracleAbi, 'isFresh'),
      this._read(c.oracle, oracleAbi, 'getPrice', [c.credit]),
    ])
    return { lastReadingTime: Number(lastReadingTime), fresh, recordedPrice, minInterval: Number(this.minInterval) }
  }

  /// Dry-runs update() so a reading that would revert (TooSoon) costs no gas.
  async simulateUpdate() {
    try {
      const { result } = await this.client.simulateContract({ address: this.cfg.oracle, abi: oracleAbi, functionName: 'update', account: this.account ?? undefined })
      return { ok: true, status: READING_STATUS[result[0]], recordedPrice: result[1] }
    } catch (err) {
      return { ok: false, errorName: revertName(err), error: err?.shortMessage ?? String(err) }
    }
  }

  async sendUpdate() {
    return this._write(this.cfg.oracle, oracleAbi, 'update')
  }

  /// ReadingTaken events since `fromBlock`, each flagged `foreign` if someone other than the agent sent it.
  async readingsSince(fromBlock, toBlock) {
    const logs = await this._logs({ address: this.cfg.oracle, event: oracleAbi.find((x) => x.name === 'ReadingTaken'), fromBlock, toBlock })
    const out = []
    for (const log of logs) {
      const [block, from] = await Promise.all([this.client.getBlock({ blockNumber: log.blockNumber }), this._sender(log.transactionHash)])
      out.push({
        time: Number(block.timestamp),
        block: log.blockNumber,
        status: READING_STATUS[log.args.status],
        rawPrice: log.args.rawPrice,
        recordedPrice: log.args.recordedPrice,
        foreign: !this.address || from.toLowerCase() !== this.address.toLowerCase(),
      })
    }
    return out
  }

  async _sender(hash) {
    if (!this._txFrom.has(hash)) this._txFrom.set(hash, (await this.client.getTransaction({ hash })).from)
    return this._txFrom.get(hash)
  }

  async _logs({ address, event, fromBlock, toBlock }) {
    const out = []
    for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK) {
      const to = from + LOG_CHUNK - 1n < toBlock ? from + LOG_CHUNK - 1n : toBlock
      out.push(...(await this.client.getLogs({ address, event, fromBlock: from, toBlock: to })))
    }
    return out
  }

  // ---------------------------------------------------------------- pool

  async borrowersSince(fromBlock, toBlock) {
    const logs = await this._logs({ address: this.cfg.pool, event: poolAbi.find((x) => x.name === 'Borrowed'), fromBlock, toBlock })
    return logs.map((l) => l.args.borrower)
  }

  async accountData(borrower) {
    const [, , debt, , healthFactor] = await this._read(this.cfg.pool, poolAbi, 'getAccountData', [borrower])
    return { debt, healthFactor }
  }

  async market() {
    const p = this.cfg.pool
    const names = ['cash', 'totalBorrows', 'totalReserves', 'utilization', 'borrowRatePerYear', 'supplyRatePerYear', 'maxDebtPerAccount', 'maxTotalBorrows', 'minDebt', 'interestRateModel']
    const values = await Promise.all(names.map((n) => this._read(p, poolAbi, n)))
    return Object.fromEntries(names.map((n, i) => [n, values[i]]))
  }

  async collateralAssets() {
    const cm = this.collateralManager
    const assets = await this._read(cm, collateralManagerAbi, 'getListedAssets')
    return Promise.all(assets.map(async (asset) => {
      const [config, price] = await Promise.all([
        this._read(cm, collateralManagerAbi, 'getAssetConfig', [asset]),
        this._read(cm, collateralManagerAbi, 'getPrice', [asset]).catch(() => null),
      ])
      return { asset, decimals: config.decimals, bonusBps: config.liqBonusBps, price }
    }))
  }

  settlementPrice() {
    return this._read(this.collateralManager, collateralManagerAbi, 'getDebtSettlementPrice')
  }

  collateralOf(borrower, asset) {
    return this._read(this.cfg.pool, poolAbi, 'collateralOf', [borrower, asset])
  }

  // ---------------------------------------------------------------- order book

  async quote(creditAtoms) {
    const q = await this._read(this.cfg.exchange, exchangeAbi, 'getQuoteForCredit', [creditAtoms, MAX_FILLS])
    return { creditOut: q.creditOut, usdgSpent: q.usdgSpent, feeAtoms: q.feeAtoms, fills: q.fills, reason: Number(q.reason) }
  }

  feeBps() {
    return this._read(this.cfg.exchange, exchangeAbi, 'feeBps').then(Number)
  }

  // ---------------------------------------------------------------- liquidation (agent wallet)

  balanceOf(token) {
    return this._read(token, erc20Abi, 'balanceOf', [this.address])
  }

  /// Approves exactly `amount` (never unlimited: the Orbio exchange is upgradeable by Orbio).
  async ensureAllowance(token, spender, amount) {
    const current = await this._read(token, erc20Abi, 'allowance', [this.address, spender])
    if (current >= amount) return null
    return this._write(token, erc20Abi, 'approve', [spender, amount])
  }

  buyCredit(usdgIn, minCreditOut) {
    return this._write(this.cfg.exchange, exchangeAbi, 'buy', [usdgIn, minCreditOut, this.address, MAX_FILLS])
  }

  liquidate(borrower, asset, repayAmount, minSeized) {
    return this._write(this.cfg.pool, poolAbi, 'liquidate', [borrower, asset, repayAmount, minSeized])
  }

  // ---------------------------------------------------------------- rate controller

  async rateState() {
    const rc = this.cfg.rateController
    const [menu, agent, pending, lastExecutedAt, cooldown, gracePeriod] = await Promise.all([
      this._read(rc, rateControllerAbi, 'menu'),
      this._read(rc, rateControllerAbi, 'agent'),
      this._read(rc, rateControllerAbi, 'pending'),
      this._read(rc, rateControllerAbi, 'lastExecutedAt'),
      this._read(rc, rateControllerAbi, 'cooldown'),
      this._read(rc, rateControllerAbi, 'gracePeriod'),
    ])
    const models = await Promise.all(menu.map(async (address) => {
      const [base, slope1, slope2, kink] = await Promise.all(['baseRatePerYear', 'slope1PerYear', 'slope2PerYear', 'kink'].map((n) => this._read(address, rateModelAbi, n)))
      return { address, base, slope1, slope2, kink }
    }))
    return {
      models,
      agent,
      pending: { model: pending[0], executableAt: Number(pending[1]) },
      lastExecutedAt: Number(lastExecutedAt),
      cooldown: Number(cooldown),
      gracePeriod: Number(gracePeriod),
    }
  }

  proposeRateModel(model) {
    return this._write(this.cfg.rateController, rateControllerAbi, 'propose', [model])
  }

  executeRateSwitch() {
    return this._write(this.cfg.rateController, rateControllerAbi, 'execute')
  }
}
