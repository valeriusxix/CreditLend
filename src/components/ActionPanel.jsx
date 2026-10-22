import { useState } from 'react'
import poolAbi from '../abi/CreditLendPool.json'
import AmountField from './AmountField.jsx'
import Button from './Button.jsx'
import TxNotice from './TxNotice.jsx'
import { useTx } from '../hooks/useTx.js'
import { parseAmount, fmtAmount, fmtHealth, healthBand, toInputString, MAX_UINT } from '../lib/format.js'
import { borrowLimits, collateralWithdrawMax, healthAfter, repayAllAllowance } from '../lib/market.js'

const TABS = [
  { id: 'lend', label: 'Lend' },
  { id: 'collateral', label: 'Collateral' },
  { id: 'borrow', label: 'Borrow' },
  { id: 'repay', label: 'Repay' },
]

/// Lend / collateral / borrow / repay: every action a user takes on their own position.
function ActionPanel({ market, account, wallet, refresh, tab, onTab }) {
  const active = TABS.some((t) => t.id === tab) ? tab : 'lend'
  const props = { market, account, wallet, refresh }
  return (
    <section className="card action-panel" aria-label="Actions">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={active === t.id} className={`tab ${active === t.id ? 'is-active' : ''}`} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {/* key: a fresh form (empty input, no old status) for each tab */}
      {active === 'lend' && <LendForm key="lend" {...props} />}
      {active === 'collateral' && <CollateralForm key="collateral" {...props} />}
      {active === 'borrow' && <BorrowForm key="borrow" {...props} />}
      {active === 'repay' && <RepayForm key="repay" {...props} />}
    </section>
  )
}

// ------------------------------------------------------------------------------------------ shared

function ModeSwitch({ modes, value, onChange }) {
  return (
    <div className="mode-switch">
      {modes.map(([id, label]) => (
        <button key={id} type="button" className={value === id ? 'is-active' : ''} aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/// The big button: connect / switch network / disabled with a reason / the action itself.
function ActionButton({ wallet, account, label, disabledReason, busy, onClick }) {
  if (!wallet.account) return <Button className="action-button" onClick={wallet.connect}>Connect wallet</Button>
  if (wallet.wrongNetwork) return <Button className="action-button" onClick={wallet.switchNetwork}>Switch to Robinhood Chain</Button>
  if (!account) return <Button className="action-button" disabled>Loading your position…</Button>
  return (
    <>
      <Button className="action-button" onClick={onClick} disabled={Boolean(disabledReason) || busy}>
        {busy ? 'Waiting for wallet…' : label}
      </Button>
      {disabledReason && disabledReason !== true && <p className="form-note">{disabledReason}</p>}
    </>
  )
}

function HealthPreview({ before, after }) {
  if (after == null || before === after) return null
  return (
    <div className="preview-row">
      <span>Health factor</span>
      <span>
        <span className={`hf hf--${healthBand(before)}`}>{fmtHealth(before)}</span>
        {' → '}
        <span className={`hf hf--${healthBand(after)}`} data-testid="health-after">{fmtHealth(after)}</span>
      </span>
    </div>
  )
}

function useAmount(decimals) {
  const [text, setText] = useState('')
  const [useMax, setUseMax] = useState(false)
  const parsed = text === '' ? null : parseAmount(text, decimals)
  return {
    text,
    useMax,
    value: parsed?.value ?? null,
    error: parsed?.error ?? null,
    set: (t) => { setText(t); setUseMax(false) },
    setMax: (v) => { setText(toInputString(v, decimals)); setUseMax(true) },
    clear: () => { setText(''); setUseMax(false) },
  }
}

// -------------------------------------------------------------------------------------------- lend

function LendForm({ market, account, wallet, refresh }) {
  const c = market.credit
  const [mode, setMode] = useState('deposit')
  const amount = useAmount(c.decimals)
  const tx = useTx({ provider: wallet.provider, account: wallet.account, onDone: () => { amount.clear(); refresh() } })

  const available = account ? (mode === 'deposit' ? account.walletCredit : account.maxWithdraw) : null
  let reason = amount.error ?? (amount.value == null ? true : null)
  if (!reason && amount.value > (available ?? 0n)) reason = mode === 'deposit' ? `Your wallet holds only ${fmtAmount(available, c.decimals)} ${c.symbol}.` : `You can withdraw at most ${fmtAmount(available, c.decimals)} ${c.symbol} right now.`
  if (mode === 'deposit' && market.paused.deposits) reason = 'New lending is paused by the guardian right now. Withdrawals still work.'

  const submit = () => {
    if (mode === 'deposit') {
      return tx.run({
        approve: { token: c.address, spender: market.pool, amount: amount.value, label: c.symbol },
        call: { address: market.pool, abi: poolAbi, functionName: 'deposit', args: [amount.value, wallet.account] },
        success: `Supplied ${amount.text} ${c.symbol}. It now earns interest.`,
      })
    }
    // "Max" redeems shares, so no dust is left behind.
    const call = amount.useMax
      ? { address: market.pool, abi: poolAbi, functionName: 'redeem', args: [account.shares < account.maxRedeem ? account.shares : account.maxRedeem, wallet.account, wallet.account] }
      : { address: market.pool, abi: poolAbi, functionName: 'withdraw', args: [amount.value, wallet.account, wallet.account] }
    return tx.run({ call, success: `Withdrew ${amount.text} ${c.symbol}.` })
  }

  return (
    <div className="form">
      <ModeSwitch modes={[['deposit', 'Supply'], ['withdraw', 'Withdraw']]} value={mode} onChange={(m) => { setMode(m); amount.clear(); tx.reset() }} />
      <p className="form-intro">
        {mode === 'deposit'
          ? `Lend ${c.symbol} to borrowers and earn interest. You receive cCREDIT, which grows in value as interest is paid.`
          : `Take back what you supplied, plus the interest earned.`}
      </p>
      <AmountField
        label={mode === 'deposit' ? 'Amount to supply' : 'Amount to withdraw'}
        value={amount.text}
        onChange={amount.set}
        symbol={c.symbol}
        balanceLabel={mode === 'deposit' ? 'Wallet' : 'Available'}
        balanceText={available == null ? null : fmtAmount(available, c.decimals, 4)}
        onMax={available ? () => amount.setMax(available) : null}
        error={amount.error}
      />
      {mode === 'withdraw' && account && account.lent > account.maxWithdraw && (
        <p className="form-note">You have {fmtAmount(account.lent, c.decimals)} {c.symbol} supplied, but only {fmtAmount(account.maxWithdraw, c.decimals)} is free in the pool right now; the rest is lent out. It frees up as borrowers repay.</p>
      )}
      <ActionButton wallet={wallet} account={account} label={mode === 'deposit' ? `Supply ${c.symbol}` : `Withdraw ${c.symbol}`} disabledReason={reason} busy={tx.busy} onClick={submit} />
      <TxNotice status={tx.status} />
    </div>
  )
}

// -------------------------------------------------------------------------------------- collateral

function CollateralForm({ market, account, wallet, refresh }) {
  const [mode, setMode] = useState('deposit')
  const [assetAddress, setAssetAddress] = useState(market.assets[0]?.address ?? null)
  const asset = market.assets.find((a) => a.address === assetAddress) ?? market.assets[0]
  const amount = useAmount(asset?.decimals ?? 6)
  const tx = useTx({ provider: wallet.provider, account: wallet.account, onDone: () => { amount.clear(); refresh() } })

  if (!asset) return <p className="form-intro">No collateral is listed yet.</p>

  const deposited = account?.collateral[asset.address] ?? 0n
  const room = asset.supplyCap > asset.totalCollateral ? asset.supplyCap - asset.totalCollateral : 0n
  const available = account ? (mode === 'deposit' ? account.wallet[asset.address] : collateralWithdrawMax(market, account, asset)) : null
  let reason = amount.error ?? (amount.value == null ? true : null)
  if (!reason && amount.value > (available ?? 0n)) {
    reason = mode === 'deposit'
      ? `Your wallet holds only ${fmtAmount(available, asset.decimals)} ${asset.symbol}.`
      : available < deposited
        ? `You can withdraw at most ${fmtAmount(available, asset.decimals)} ${asset.symbol} while you have debt. Repay first to free more.`
        : `You have only ${fmtAmount(deposited, asset.decimals)} ${asset.symbol} deposited.`
  }
  if (!reason && mode === 'deposit' && amount.value > room) reason = `This collateral is close to its deposit limit: at most ${fmtAmount(room, asset.decimals)} ${asset.symbol} more can be added.`
  if (mode === 'deposit' && (market.paused.collateral || !asset.depositsEnabled)) reason = `New ${asset.symbol} deposits are paused right now. Withdrawals still work.`
  const after = account && amount.value ? healthAfter({ market, account, asset: asset.address, collateralDelta: mode === 'deposit' ? amount.value : -amount.value }) : null

  const submit = () => {
    if (mode === 'deposit') {
      return tx.run({
        approve: { token: asset.address, spender: market.pool, amount: amount.value, label: asset.symbol },
        call: { address: market.pool, abi: poolAbi, functionName: 'depositCollateral', args: [asset.address, amount.value, wallet.account] },
        success: `Deposited ${amount.text} ${asset.symbol} as collateral.`,
      })
    }
    const all = amount.useMax && account.debt === 0n
    return tx.run({
      call: { address: market.pool, abi: poolAbi, functionName: 'withdrawCollateral', args: [asset.address, all ? MAX_UINT : amount.value, wallet.account] },
      success: `Withdrew ${amount.text} ${asset.symbol} of collateral.`,
    })
  }

  return (
    <div className="form">
      <ModeSwitch modes={[['deposit', 'Deposit'], ['withdraw', 'Withdraw']]} value={mode} onChange={(m) => { setMode(m); amount.clear(); tx.reset() }} />
      <p className="form-intro">
        Collateral backs what you borrow. You can borrow up to {asset.ltvBps / 100}% of its value; if your debt passes {asset.liqThresholdBps / 100}%, it can be liquidated with a {asset.liqBonusBps / 100}% bonus to the liquidator.
      </p>
      {market.assets.length > 1 && (
        <label className="select-field">
          <span>Collateral</span>
          <select value={asset.address} onChange={(e) => { setAssetAddress(e.target.value); amount.clear() }}>
            {market.assets.map((a) => <option key={a.address} value={a.address}>{a.symbol}</option>)}
          </select>
        </label>
      )}
      <AmountField
        label={mode === 'deposit' ? 'Amount to deposit' : 'Amount to withdraw'}
        value={amount.text}
        onChange={amount.set}
        symbol={asset.symbol}
        balanceLabel={mode === 'deposit' ? 'Wallet' : 'Withdrawable'}
        balanceText={available == null ? null : fmtAmount(available, asset.decimals, 4)}
        onMax={available ? () => amount.setMax(available) : null}
        error={amount.error}
      />
      {account && <HealthPreview before={account.healthFactor} after={after} />}
      <ActionButton wallet={wallet} account={account} label={mode === 'deposit' ? `Deposit ${asset.symbol}` : `Withdraw ${asset.symbol}`} disabledReason={reason} busy={tx.busy} onClick={submit} />
      <TxNotice status={tx.status} />
    </div>
  )
}

// ------------------------------------------------------------------------------------------ borrow

function BorrowForm({ market, account, wallet, refresh }) {
  const c = market.credit
  const amount = useAmount(c.decimals)
  const tx = useTx({ provider: wallet.provider, account: wallet.account, onDone: () => { amount.clear(); refresh() } })
  const limits = account ? borrowLimits(market, account) : null
  const after = account && amount.value ? healthAfter({ market, account, debtDelta: amount.value }) : null

  let reason = amount.error ?? (amount.value == null ? true : null)
  if (account && account.borrowPower === 0n) reason = 'Deposit collateral first (Collateral tab).'
  else if (!reason && limits && amount.value > limits.max) reason = `You can borrow at most ${fmtAmount(limits.max, c.decimals)} ${c.symbol} now (limited by ${limits.limitedBy}).`
  else if (!reason && limits && amount.value < limits.min) reason = `The minimum loan is ${fmtAmount(market.minDebt, c.decimals)} ${c.symbol} in total, so borrow at least ${fmtAmount(limits.min, c.decimals)}.`
  if (market.paused.borrows) reason = 'New borrowing is paused by the guardian right now. Repaying still works.'

  const submit = () => tx.run({
    call: { address: market.pool, abi: poolAbi, functionName: 'borrow', args: [amount.value] },
    success: `Borrowed ${amount.text} ${c.symbol}. It is now in your wallet.`,
  })

  return (
    <div className="form">
      <p className="form-intro">
        Borrow {c.symbol} against your collateral. Debt grows with interest and always counts at $1 per {c.symbol}. Keep your health factor above 1, or part of your collateral can be sold to repay it.
      </p>
      <AmountField
        label="Amount to borrow"
        value={amount.text}
        onChange={amount.set}
        symbol={c.symbol}
        balanceLabel="You can borrow"
        balanceText={limits ? fmtAmount(limits.max, c.decimals, 4) : null}
        onMax={limits?.max > 0n ? () => amount.setMax(limits.max) : null}
        error={amount.error}
      />
      {account && <HealthPreview before={account.healthFactor} after={after} />}
      {limits && limits.max > 0n && <p className="form-note subtle">Your limit is set by {limits.limitedBy}. Minimum loan: {fmtAmount(market.minDebt, c.decimals)} {c.symbol}.</p>}
      <ActionButton wallet={wallet} account={account} label={`Borrow ${c.symbol}`} disabledReason={reason} busy={tx.busy} onClick={submit} />
      <TxNotice status={tx.status} />
    </div>
  )
}

// ------------------------------------------------------------------------------------------- repay

function RepayForm({ market, account, wallet, refresh }) {
  const c = market.credit
  const amount = useAmount(c.decimals)
  const tx = useTx({ provider: wallet.provider, account: wallet.account, onDone: () => { amount.clear(); refresh() } })
  const debt = account?.debt ?? 0n
  const wallet$ = account?.walletCredit ?? 0n
  const max = debt < wallet$ ? debt : wallet$
  // Paying off everything: the debt keeps growing until the transaction lands, so send "all" and approve a small buffer.
  const payAll = amount.useMax && debt > 0n && wallet$ >= repayAllAllowance(debt)
  const after = account && amount.value ? healthAfter({ market, account, debtDelta: -(amount.value > debt ? debt : amount.value) }) : null

  let reason = amount.error ?? (amount.value == null ? true : null)
  if (account && debt === 0n) reason = 'You have no debt to repay.'
  else if (!reason && amount.value > wallet$) reason = `Your wallet holds only ${fmtAmount(wallet$, c.decimals)} ${c.symbol}.`

  const submit = () => tx.run({
    approve: { token: c.address, spender: market.pool, amount: payAll ? repayAllAllowance(debt) : amount.value, label: c.symbol },
    call: { address: market.pool, abi: poolAbi, functionName: 'repay', args: [payAll ? MAX_UINT : amount.value, wallet.account] },
    success: payAll ? 'Repaid your whole debt.' : `Repaid ${amount.text} ${c.symbol}.`,
  })

  return (
    <div className="form">
      <p className="form-intro">Pay back what you borrowed, in {c.symbol}. Repaying is never paused.</p>
      <AmountField
        label="Amount to repay"
        value={amount.text}
        onChange={amount.set}
        symbol={c.symbol}
        balanceLabel="Debt"
        balanceText={account ? fmtAmount(debt, c.decimals, 4) : null}
        onMax={max > 0n ? () => amount.setMax(max) : null}
        error={amount.error}
      />
      {account && debt > wallet$ && debt > 0n && <p className="form-note subtle">Your wallet holds {fmtAmount(wallet$, c.decimals)} {c.symbol}, less than the full debt.</p>}
      {account && <HealthPreview before={account.healthFactor} after={after} />}
      <ActionButton wallet={wallet} account={account} label={payAll ? 'Repay all' : `Repay ${c.symbol}`} disabledReason={reason} busy={tx.busy} onClick={submit} />
      <TxNotice status={tx.status} />
    </div>
  )
}

export default ActionPanel
