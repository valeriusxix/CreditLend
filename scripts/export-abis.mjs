// Copies the contract ABIs the frontend uses from the Foundry build (contracts/out, not committed) into
// src/abi (committed). Run after changing a contract:  cd contracts && forge build && cd .. && npm run abis
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const contracts = {
  CreditLendPool: 'CreditLendPool.sol/CreditLendPool.json',
  CollateralManager: 'CollateralManager.sol/CollateralManager.json',
  ERC20: 'ERC20.sol/ERC20.json', // OpenZeppelin ERC20: balanceOf, allowance, approve, decimals, symbol + its errors
}

const outDir = new URL('../src/abi/', import.meta.url)
mkdirSync(outDir, { recursive: true })
for (const [name, path] of Object.entries(contracts)) {
  const { abi } = JSON.parse(readFileSync(new URL(`../contracts/out/${path}`, import.meta.url), 'utf8'))
  writeFileSync(new URL(`${name}.json`, outDir), JSON.stringify(abi, null, 2) + '\n')
  console.log(`${name}: ${abi.length} entries`)
}
