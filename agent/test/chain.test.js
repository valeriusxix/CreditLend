import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeErrorResult, ContractFunctionExecutionError, ContractFunctionRevertedError } from 'viem'
import { revertName, paddedGas, ChainAdapter } from '../src/chain.js'
import { oracleAbi } from '../src/abis.js'

test('revertName finds the custom error name viem nests inside a failed call', () => {
  const data = encodeErrorResult({ abi: oracleAbi, errorName: 'TooSoon', args: [123n] })
  const err = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: oracleAbi, data, functionName: 'update' }), {
    abi: oracleAbi,
    functionName: 'update',
    args: [],
    contractAddress: '0x0000000000000000000000000000000000000001',
  })
  assert.doesNotMatch(err.shortMessage, /TooSoon/, 'the short message alone would miss it')
  assert.equal(revertName(err), 'TooSoon')
  assert.equal(revertName(new Error('plain')), null)
})

test('transactions get a padded gas limit (interest accrual can need more gas than estimated)', async () => {
  assert.equal(paddedGas(100_000n), 180_000n)
  const sent = []
  const adapter = Object.create(ChainAdapter.prototype)
  adapter.account = { address: '0x0000000000000000000000000000000000000001' }
  adapter.client = {
    simulateContract: async () => ({ request: { functionName: 'update' } }),
    estimateContractGas: async () => 110_136n, // the estimate that ran out of gas on the fork
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  }
  adapter.wallet = { writeContract: async (req) => { sent.push(req); return '0xh' } }
  await adapter._write('0x0000000000000000000000000000000000000002', oracleAbi, 'update')
  assert.equal(sent[0].gas, paddedGas(110_136n))
  assert.ok(sent[0].gas > 152_709n, 'covers what the transaction really used')
})
