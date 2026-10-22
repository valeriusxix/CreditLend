// Settings come from environment variables (see .env.example). Secrets are never logged.
import { getAddress, isAddress } from 'viem'

export const ROBINHOOD = {
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  credit: '0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  exchange: '0x6951fFd32630b05e06F50062AEA801625A58eBC0',
  // Orbio agent launchpad vault (matches https://www.orbio.so/api/protocol/agents/terms, 2026-10-22)
  agentVault: '0x0E1651aEC67B2a049a4FA6aEb6C1c305aabfc35b',
}

const bool = (v) => /^(1|true|yes|on)$/i.test(v ?? '')

function address(env, name, { required = true } = {}) {
  const v = env[name]
  if (!v) {
    if (required) throw new Error(`${name} is not set`)
    return null
  }
  if (!isAddress(v, { strict: false })) throw new Error(`${name} is not a valid address`)
  return getAddress(v)
}

/// A whole or decimal amount of CREDIT (or dollars) as 6-decimal atoms.
function credit(env, name, fallback) {
  const v = env[name] || fallback
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error(`${name} must be a plain number like 1 or 0.5`)
  const [whole, frac = ''] = v.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'))
}

export function loadConfig(env = process.env) {
  const privateKey = env.AGENT_PRIVATE_KEY || null
  if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('AGENT_PRIVATE_KEY must be 0x followed by 64 hex characters')

  const cfg = {
    rpcUrl: env.RPC_URL || ROBINHOOD.rpcUrl,
    credit: ROBINHOOD.credit,
    usdg: ROBINHOOD.usdg,
    exchange: ROBINHOOD.exchange,
    pool: address(env, 'POOL_ADDRESS'),
    oracle: address(env, 'ORACLE_ADDRESS'),
    rateController: address(env, 'RATE_CONTROLLER_ADDRESS', { required: false }),
    poolDeployBlock: BigInt(env.POOL_DEPLOY_BLOCK || '0'),
    privateKey,

    liquidatorEnabled: bool(env.LIQUIDATOR_ENABLED),
    minProfitBps: Number(env.LIQUIDATOR_MIN_PROFIT_BPS || '100'),
    rateProposalsEnabled: bool(env.RATE_PROPOSALS_ENABLED),

    // Launchpad funding: on once the owner has launched the agent's token and set its address here.
    agentVault: ROBINHOOD.agentVault,
    agentToken: address(env, 'AGENT_TOKEN_ADDRESS', { required: false }),
    fundingActivate: bool(env.FUNDING_ACTIVATE),
    fundingMinClaim: credit(env, 'FUNDING_MIN_CLAIM_CREDIT', '1'),
    gatewayFloor: credit(env, 'GATEWAY_BALANCE_FLOOR_USD', '20'),
    orbioApiKey: env.ORBIO_API_KEY || null,

    llm: env.ORBIO_API_KEY ?{ apiKey: env.ORBIO_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, model: env.AGENT_MODEL || 'anthropic/claude-opus-5.5' } : null,

    alerts: {
      webhookUrl: env.ALERT_WEBHOOK_URL || null,
      telegramBotToken: env.TELEGRAM_BOT_TOKEN || null,
      telegramChatId: env.TELEGRAM_CHAT_ID || null,
    },
    tickSeconds: Number(env.TICK_SECONDS || '60'),
  }
  if (!Number.isInteger(cfg.minProfitBps) || cfg.minProfitBps < 0 || cfg.minProfitBps > 5_000) throw new Error('LIQUIDATOR_MIN_PROFIT_BPS must be 0..5000')
  if (cfg.liquidatorEnabled && !privateKey) throw new Error('LIQUIDATOR_ENABLED needs AGENT_PRIVATE_KEY')
  return cfg
}

/// A one-line description of what is switched on, safe to print (no secrets).
export function describe(cfg, agentAddress) {
  return [
    `wallet: ${agentAddress ?? 'none (read-only: monitoring and alerts only)'}`,
    `auto-liquidation: ${cfg.liquidatorEnabled ? `on (min profit ${cfg.minProfitBps / 100}%)` : 'off'}`,
    `daily AI review: ${cfg.llm ? `on (${cfg.llm.model})` : 'off (no ORBIO_API_KEY)'}`,
    `rate proposals: ${cfg.rateProposalsEnabled && cfg.rateController ? 'on' : 'off'}`,
    `launchpad funding: ${cfg.agentToken ? `on (claims ${cfg.fundingActivate ? 'into API balance when low' : 'as CREDIT tokens'})` : 'off (no AGENT_TOKEN_ADDRESS)'}`,
    `chat alerts: ${[cfg.alerts.webhookUrl && 'webhook', cfg.alerts.telegramBotToken && cfg.alerts.telegramChatId && 'telegram'].filter(Boolean).join(' + ') || 'log only'}`,
  ].join(' | ')
}
