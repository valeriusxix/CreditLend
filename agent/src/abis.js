// Minimal ABIs for the calls the agent makes. Signatures are copied from ../contracts/src and from the
// verified OrbioExchange source (Sourcify, implementation 0x2d253e15...fbb7).
import { parseAbi } from 'viem'

export const poolAbi = parseAbi([
  'function collateralManager() view returns (address)',
  'function interestRateModel() view returns (address)',
  'function getAccountData(address) view returns (uint256 borrowPower, uint256 liqValue, uint256 debt, uint256 debtValue, uint256 healthFactor)',
  'function debtOf(address) view returns (uint256)',
  'function collateralOf(address, address) view returns (uint256)',
  'function minDebt() view returns (uint256)',
  'function cash() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function totalReserves() view returns (uint256)',
  'function utilization() view returns (uint256)',
  'function borrowRatePerYear() view returns (uint256)',
  'function supplyRatePerYear() view returns (uint256)',
  'function maxDebtPerAccount() view returns (uint256)',
  'function maxTotalBorrows() view returns (uint256)',
  'function maxUtilizationBps() view returns (uint256)',
  'function liquidate(address borrower, address collateralAsset, uint256 repayAmount, uint256 minSeized) returns (uint256 repaid, uint256 seized)',
  'event Borrowed(address indexed borrower, uint256 amount, uint256 newDebt)',
])

export const collateralManagerAbi = parseAbi([
  'function getListedAssets() view returns (address[])',
  'function getPrice(address) view returns (uint256)',
  'function getDebtSettlementPrice() view returns (uint256)',
  'struct AssetConfig { bool listed; bool depositsEnabled; uint8 decimals; uint16 ltvBps; uint16 liqThresholdBps; uint16 liqBonusBps; uint256 supplyCap; }',
  'function getAssetConfig(address) view returns (AssetConfig)',
])

export const oracleAbi = parseAbi([
  'function update() returns (uint8 status, uint256 recordedPrice)',
  'function getPrice(address) view returns (uint256)',
  'function isFresh() view returns (bool)',
  'function latestObservation() view returns (uint256 timestamp, uint256 price)',
  'function lastReadingTime() view returns (uint256)',
  'function minInterval() view returns (uint256)',
  'function referenceSize() view returns (uint256)',
  'function credit() view returns (address)',
  'error TooSoon(uint256 nextAllowed)',
  'event ReadingTaken(uint8 indexed status, uint256 rawPrice, uint256 recordedPrice)',
  'event HistoryRestarted(uint256 timestamp)',
])

export const rateControllerAbi = parseAbi([
  'function menu() view returns (address[])',
  'function agent() view returns (address)',
  'function pending() view returns (address model, uint64 executableAt)',
  'function lastExecutedAt() view returns (uint256)',
  'function nextProposalAllowed() view returns (uint256)',
  'function cooldown() view returns (uint256)',
  'function gracePeriod() view returns (uint256)',
  'function propose(address model)',
  'function execute()',
])

export const rateModelAbi = parseAbi([
  'function baseRatePerYear() view returns (uint256)',
  'function slope1PerYear() view returns (uint256)',
  'function slope2PerYear() view returns (uint256)',
  'function kink() view returns (uint256)',
])

export const exchangeAbi = parseAbi([
  'struct Quote { uint256 creditOut; uint256 usdgSpent; uint256 feeAtoms; uint256 fills; uint8 reason; }',
  'function getQuoteForCredit(uint256 creditAtoms, uint256 maxFills) view returns (Quote)',
  'function buy(uint256 usdgIn, uint256 minCreditOut, address recipient, uint256 maxFills) returns (uint256 creditOut, uint256 usdgSpent)',
  'function feeBps() view returns (uint16)',
])

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
])

// CreditPriceOracle.ReadingStatus
export const READING_STATUS = ['Accepted', 'Clamped', 'RejectedIncomplete', 'RejectedDivergent']
// IOrbioExchange.StopReason
export const STOP_REASON = ['BudgetSpent', 'LiquidityExhausted', 'UnitUnaffordable', 'WorkLimit', 'TargetReached']
export const TARGET_REACHED = 4
export const MAX_FILLS = 64n
