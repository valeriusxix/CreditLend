import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeErrorResult, ContractFunctionExecutionError, ContractFunctionRevertedError } from 'viem'
import { revertName } from '../src/chain.js'
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
