import 'dotenv/config'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { concatHex, createPublicClient, createWalletClient, encodeAbiParameters, formatUnits, getAddress, http, keccak256, parseUnits, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ARC = {
  id: 5_042_002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || 'https://rpc.testnet.arc.io'] } },
} as const

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and set it.`)
  return value
}

function numberSetting(name: string, fallback: number, minimum = 0): number {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a number greater than or equal to ${minimum}.`)
  }
  return parsed
}

const config = {
  dryRun: process.env.DRY_RUN !== 'false',
  fastMode: process.env.FAST_MODE === 'true',
  minBalance: numberSetting('MIN_BALANCE_USDC', 3),
  maxBuy: numberSetting('MAX_BUY_USDC', 10, 1),
  maxCycles: numberSetting('MAX_CYCLES', 0),
  maxTotalSpend: numberSetting('MAX_TOTAL_SPEND_USDC', 50, 1),
  sellPercent: numberSetting('SELL_PERCENT', 25, 1),
  profitTargetPercent: numberSetting('PROFIT_TARGET_PERCENT', 20, 0),
  closeLegacyPositions: process.env.CLOSE_LEGACY_POSITIONS === 'true',
  legacyClosePercent: numberSetting('LEGACY_CLOSE_PERCENT', 100, 1),
  maxLegacyClosesPerCycle: numberSetting('MAX_LEGACY_CLOSES_PER_CYCLE', 5, 1),
  autoBond: process.env.AUTO_BOND === 'true',
  autoUnbond: process.env.AUTO_UNBOND === 'true',
  maxBondUsdc: numberSetting('MAX_BOND_USDC', 1, 1),
  bondTokenPercent: numberSetting('BOND_TOKEN_PERCENT', 10, 1),
  unbondPercent: numberSetting('UNBOND_PERCENT', 100, 1),
  unbondAfterCycles: numberSetting('UNBOND_AFTER_CYCLES', 2, 0),
  discoveryBlocks: numberSetting('DISCOVERY_BLOCKS', 5_000, 100),
}

if (config.maxBuy < 1.5) throw new Error('MAX_BUY_USDC must be at least 1.5.')

if (config.sellPercent > 100) throw new Error('SELL_PERCENT must not exceed 100.')
if (config.legacyClosePercent > 100) throw new Error('LEGACY_CLOSE_PERCENT must not exceed 100.')
if (config.bondTokenPercent > 100 || config.unbondPercent > 100) throw new Error('Bond and unbond percentages must not exceed 100.')
const account = privateKeyToAccount(required('PRIVATE_KEY') as `0x${string}`)
const publicClient = createPublicClient({ chain: ARC, transport: http() })
const walletClient = createWalletClient({ account, chain: ARC, transport: http() })

const FLIPT = {
  router: '0x4b33146f2bcc75574534374c85662f9e51c38aca' as Address,
  lens: '0x6ab2635fec3c426d825d005e24cfc05b82ea3994' as Address,
  usdc: '0x4f3b8005d6b3f4994a791d971bcd153e114d20c2' as Address,
  createSelector: '0xe43d45f0' as Hex,
  buySelector: '0xc3b88b53' as Hex,
  sellSelector: '0x6a272462' as Hex,
  collectSelector: '0x06ec16f8' as Hex,
  launchEvent: '0x4b0d70e7e0cdb8221fc029a6d8b8df90893d2756ded597aeea9118a06a7e0e95' as Hex,
  defaultTarget: '0x05f2b07f2002f045a5eac3c067078bd6427b69d2' as Address,
  usdcDecimals: 6,
} as const

const FLIPT_ABI = [{ type: 'function', name: 'graduationFactory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const
const LENS_ABI = [{ type: 'function', name: 'TOTAL_SUPPLY', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const
const GRADUATION_FACTORY_ABI = [
  { type: 'function', name: 'tokenInitCodeHash', stateMutability: 'view', inputs: [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'VANITY_MASK', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'VANITY_SUFFIX', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const CREATE_ARGUMENTS = [
  { type: 'string' },
  { type: 'string' },
  { type: 'string' },
  { type: 'bytes32' },
  { type: 'uint256[]' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
] as const

const CREATE_ICON_URIS = (process.env.CREATE_ICON_URIS ?? process.env.CREATE_ICON_URI ?? '')
  .split(',')
  .map((uri) => uri.trim())
  .filter(Boolean)
const MIN_TOKENS_OUT = BigInt(process.env.MIN_TOKENS_OUT || '0')

const MIN_USDC_OUT = BigInt(process.env.MIN_USDC_OUT || '0')
function launchIconUri(name: string, symbol: string) {
  if (CREATE_ICON_URIS.length) return CREATE_ICON_URIS[rand(0, CREATE_ICON_URIS.length - 1)]
  return `https://api.dicebear.com/9.x/identicon/png?seed=${encodeURIComponent(`${name}-${symbol}`)}&size=256`
}

function encodeCreate(name: string, symbol: string, iconUri: string, salt: Hex, initialBuy: bigint): Hex {
  return concatHex([FLIPT.createSelector, encodeAbiParameters(CREATE_ARGUMENTS, [name, symbol, iconUri, salt, [], initialBuy, 0n, 0n])])
}

function encodeBuy(token: Address, amount: bigint): Hex {
  return concatHex([FLIPT.buySelector, encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [token, amount, MIN_TOKENS_OUT])])
}

function encodeSell(token: Address, amount: bigint): Hex {
  return concatHex([FLIPT.sellSelector, encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [token, amount, MIN_USDC_OUT])])
}

function encodeCollect(token: Address): Hex {
  return concatHex([FLIPT.collectSelector, encodeAbiParameters([{ type: 'address' }], [token])])
}

function encodeBond(token: Address, tokenAmount: bigint, usdcAmount: bigint): Hex {
  const deadline = BigInt(Math.floor(Date.now() / 1_000) + 10 * 60)
  return concatHex(['0x2aaeb990', encodeAbiParameters([
    { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
  ], [token, tokenAmount, usdcAmount, 0n, 0n, 0n, deadline])])
}

function encodeUnbond(token: Address, liquidity: bigint): Hex {
  const deadline = BigInt(Math.floor(Date.now() / 1_000) + 10 * 60)
  return concatHex(['0x13928082', encodeAbiParameters([
    { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'uint256' },
  ], [token, liquidity, 0n, 0n, deadline])])
}
async function ensureUsdcAllowance(requiredAmount: bigint) {
  const allowanceData = concatHex(['0xdd62ed3e', encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [account.address, FLIPT.router])])
  const allowanceResult = await publicClient.call({ to: FLIPT.usdc, data: allowanceData })
  const allowance = BigInt(allowanceResult.data || '0x0')
  if (allowance >= requiredAmount) return

  const approveData = concatHex(['0x095ea7b3', encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [FLIPT.router, (1n << 256n) - 1n])])
  const hash = await walletClient.sendTransaction({ to: FLIPT.usdc, data: approveData })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`USDC approval failed: ${hash}`)
  console.log(`  -> USDC approval confirmed: ${hash}`)
}

async function ensureTokenAllowance(token: Address, requiredAmount: bigint) {
  const allowanceData = concatHex(['0xdd62ed3e', encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [account.address, FLIPT.router])])
  const allowanceResult = await publicClient.call({ to: token, data: allowanceData })
  const allowance = BigInt(allowanceResult.data || '0x0')
  if (allowance >= requiredAmount) return

  const approveData = concatHex(['0x095ea7b3', encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [FLIPT.router, requiredAmount])])
  const hash = await walletClient.sendTransaction({ to: token, data: approveData })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Token approval failed: ${hash}`)
  console.log(`  -> token approval confirmed: ${hash}`)
}
async function grindLaunchSalt(name: string, symbol: string): Promise<{ salt: Hex; address: Address }> {
  const [graduationFactory, totalSupply] = await Promise.all([
    publicClient.readContract({ address: FLIPT.router, abi: FLIPT_ABI, functionName: 'graduationFactory' }),
    publicClient.readContract({ address: FLIPT.lens, abi: LENS_ABI, functionName: 'TOTAL_SUPPLY' }),
  ])
  const factory = graduationFactory as Address
  const [initCodeHash, mask, suffix] = await Promise.all([
    publicClient.readContract({ address: factory, abi: GRADUATION_FACTORY_ABI, functionName: 'tokenInitCodeHash', args: [name, symbol, totalSupply] }),
    publicClient.readContract({ address: factory, abi: GRADUATION_FACTORY_ABI, functionName: 'VANITY_MASK' }),
    publicClient.readContract({ address: factory, abi: GRADUATION_FACTORY_ABI, functionName: 'VANITY_SUFFIX' }),
  ])

  for (let counter = 0; counter <= 0xffff_ffff; counter += 1) {
    const salt = toHex(counter, { size: 32 })
    const saltHash = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [account.address, salt]))
    const hash = keccak256(concatHex(['0xff', factory, saltHash, initCodeHash]))
    const token = getAddress(`0x${hash.slice(-40)}`)
    if ((BigInt(`0x${token.slice(-4)}`) & mask) !== (suffix & mask)) continue
    console.log(`  -> vanity salt found after ${counter.toLocaleString()} attempts`)
    return { salt, address: token }
    if (counter > 0 && counter % 2048 === 0) await sleep(0)
  }
  throw new Error('Unable to find an unused vanity salt.')
}
const dataDir = path.resolve('data')
const eventsPath = path.join(dataDir, 'events.jsonl')
const statsPath = path.join(dataDir, 'stats.json')

type Action = 'create' | 'buy' | 'sell' | 'bond' | 'collect' | 'unbond' | 'hold'
type Stats = Record<Action, number> & { cycles: number; spentUsd: number; nativeGasUsdc: number; fliptUsdc: number; startedAt: string; updatedAt: string }

let activeToken: Address | undefined
let stopping = false
let trackedTokens: Address[] = []
let createdTokens: Address[] = []
let paused = false
let activeStats: Stats | undefined

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min
const randFloat = (min: number, max: number) => Math.random() * (max - min) + min
const pause = async (minMs: number, maxMs: number) => {
  const multiplier = config.fastMode ? 0.02 : 1
  await sleep(Math.round(rand(minMs, maxMs) * multiplier))
}

function randomName() {
  const crypto = ['Satoshi', 'Nakamoto', 'Block', 'Chain', 'Ether', 'Sol', 'Axiom', 'Nova', 'Orbit', 'Ledger', 'Vault', 'Cipher', 'Quantum', 'Helix', 'Lumen']
  const launch = ['Fi', 'Swap', 'Protocol', 'Network', 'Vault', 'Yield', 'Pulse', 'Capital', 'Labs', 'Node', 'Bridge', 'Forge', 'Pay', 'Stream', 'Chain']
  return `${crypto[rand(0, crypto.length - 1)]}${launch[rand(0, launch.length - 1)]}`
}

function randomSymbol(name: string) {
  const parts = name.match(/[A-Z][a-z]*/g) || [name]
  const symbol = parts.map((part) => part.slice(0, 3)).join('').toUpperCase()
  return symbol.slice(0, 5)
}

async function loadStats(): Promise<Stats> {
  const blank: Stats = { cycles: 0, spentUsd: 0, nativeGasUsdc: 0, fliptUsdc: 0, create: 0, buy: 0, sell: 0, bond: 0, collect: 0, unbond: 0, hold: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  try {
    return { ...blank, ...(JSON.parse(await readFile(statsPath, 'utf8')) as Partial<Stats>) }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return blank
    throw error
  }
}

async function record(stats: Stats, action: Action, details: Record<string, unknown> = {}) {
  stats[action] += 1
  stats.updatedAt = new Date().toISOString()
  await Promise.all([
    appendFile(eventsPath, `${JSON.stringify({ at: stats.updatedAt, action, dryRun: config.dryRun, ...details })}\n`),
    writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`),
  ])
  const token = typeof details.token === 'string' ? ` ${details.token}` : ''
  const hash = typeof details.hash === 'string' ? `\n${details.hash}` : ''
  void telegramNotify(`[${config.dryRun ? 'DRY' : 'LIVE'}] ${action}${token}${hash}`)
}

const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim()
const telegramChatId = process.env.TELEGRAM_CHAT_ID?.trim()

async function telegramNotify(message: string) {
  if (!telegramToken || !telegramChatId) return
  try {
    await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: message, disable_web_page_preview: true }),
    })
  } catch (error) {
    console.error('Telegram notification failed:', error)
  }
}

async function registerTelegramCommands() {
  if (!telegramToken) return
  try {
    await fetch(`https://api.telegram.org/bot${telegramToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: 'Resume trading cycles' },
          { command: 'resume', description: 'Resume trading cycles' },
          { command: 'pause', description: 'Pause after the current transaction' },
          { command: 'stop', description: 'Pause after the current transaction' },
          { command: 'status', description: 'Show balances and totals' },
          { command: 'help', description: 'Show available commands' },
        ],
      }),
    })
  } catch (error) {
    console.error('Telegram command registration failed:', error)
  }
}

function telegramStatus() {
  const stats = activeStats
  return [
    'Flipt Testnet bot',
    `State: ${paused ? 'paused' : 'running'}`,
    `Gas USDC: ${(stats?.nativeGasUsdc ?? 0).toFixed(2)}`,
    `Flipt USDC: ${(stats?.fliptUsdc ?? 0).toFixed(2)}`,
    `Cycles: ${stats?.cycles ?? 0}`,
    `Creates / buys / sells: ${stats?.create ?? 0} / ${stats?.buy ?? 0} / ${stats?.sell ?? 0}`,
    `Creator collections: ${stats?.collect ?? 0}`,
    `Tracked spend: $${(stats?.spentUsd ?? 0).toFixed(2)}`,
  ].join('\n')
}

async function startTelegramPolling() {
  if (!telegramToken || !telegramChatId) {
    console.log('Telegram controls disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable).')
    return
  }
  let offset = 0
  console.log('Telegram controls enabled for the configured chat.')
  while (!stopping) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${telegramToken}/getUpdates?timeout=25&offset=${offset}`)
      const body = await response.json() as { ok?: boolean; result?: Array<{ update_id: number; message?: { chat?: { id?: number | string }; text?: string } }> }
      if (!body.ok || !body.result) continue
      for (const update of body.result) {
        offset = update.update_id + 1
        const message = update.message
        if (!message?.text || String(message.chat?.id) !== telegramChatId) continue
        const command = message.text.trim().split(/\s+/)[0].toLowerCase().replace(/@[^\s]+$/, '')
        if (command === '/start' || command === '/resume') {
          paused = false
          await telegramNotify(`Runner resumed.\n\n${telegramStatus()}`)
        } else if (command === '/pause' || command === '/stop') {
          paused = true
          await telegramNotify('Runner paused after any in-flight transaction completes.')
        } else if (command === '/status') {
          await telegramNotify(telegramStatus())
        } else if (command === '/help') {
          await telegramNotify('Commands:\n/start or /resume — run cycles\n/pause or /stop — pause after the current transaction\n/status — balances and totals')
        }
      }
    } catch (error) {
      console.error('Telegram polling failed:', error)
      await sleep(5_000)
    }
  }
}
function requireContractIntegration(action: string): never {
  throw new Error(`${action} has no verified Flipt contract integration. Keep DRY_RUN=true until contract address, ABI, and function arguments are confirmed.`)
}

async function loadTrackedTokens() {
  try {
    const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean)
    const seen = new Set<Address>()
    const own = new Set<Address>()
    for (const line of lines) {
      const event = JSON.parse(line) as { action?: string; token?: unknown }
      if (typeof event.token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(event.token)) continue
      const token = getAddress(event.token)
      seen.add(token)
      if (event.action === 'create') own.add(token)
    }
    trackedTokens = [...seen]
    createdTokens = [...own]
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function discoverOtherLaunches(): Promise<Address[]> {
  const latest = await publicClient.getBlockNumber()
  const fromBlock = latest > BigInt(config.discoveryBlocks) ? latest - BigInt(config.discoveryBlocks) : 0n
  const logs = await publicClient.request({ method: 'eth_getLogs', params: [{ address: FLIPT.router, fromBlock: toHex(fromBlock), toBlock: 'latest', topics: [FLIPT.launchEvent] }] })
  const candidates = logs.flatMap((log) => {
    const topic = log.topics[1]
    if (!topic) return []
    const token = getAddress(`0x${topic.slice(-40)}`)
    return token === FLIPT.defaultTarget || token === activeToken ? [] : [token]
  })
  return [...new Set(candidates)].sort(() => Math.random() - 0.5).slice(0, 12)
}

async function tokenBalance(token: Address): Promise<bigint> {
  const data = concatHex(['0x70a08231', encodeAbiParameters([{ type: 'address' }], [account.address])])
  const result = await publicClient.call({ to: token, data })
  return BigInt(result.data || '0x0')
}

async function collectCreatorRewards(stats: Stats) {
  if (config.dryRun || createdTokens.length === 0) return
  for (const token of createdTokens.slice(0, 3)) {
    const data = encodeCollect(token)
    try {
      await publicClient.call({ account: account.address, to: FLIPT.router, data })
      const hash = await walletClient.sendTransaction({ to: FLIPT.router, data })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`Collect transaction failed: ${hash}`)
      await record(stats, 'collect', { token, hash })
      console.log(`[COLLECT] creator fees claimed for ${token}: ${hash}`)
    } catch (error) {
      console.log(`[COLLECT] no claimable creator fees for ${token}`)
      console.debug(error)
    }
  }
}

type CostPosition = { token: Address; units: bigint; costUsd: number }

async function loadCostPositions(): Promise<CostPosition[]> {
  const positions = new Map<Address, CostPosition>()
  try {
    const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const event = JSON.parse(line) as { action?: string; token?: unknown; tokenAmount?: unknown; amountUsd?: unknown; initialBuyUsd?: unknown }
      if (typeof event.token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(event.token) || typeof event.tokenAmount !== 'string') continue
      const token = getAddress(event.token)
      const units = BigInt(event.tokenAmount)
      const position = positions.get(token) ?? { token, units: 0n, costUsd: 0 }
      if (event.action === 'buy' || event.action === 'create') {
        const costUsd = Number(event.amountUsd ?? event.initialBuyUsd ?? 0)
        if (Number.isFinite(costUsd) && costUsd > 0 && units > 0n) {
          position.units += units
          position.costUsd += costUsd
        }
      } else if (event.action === 'sell' && units > 0n && position.units > 0n) {
        const sold = units > position.units ? position.units : units
        position.costUsd *= Number(position.units - sold) / Number(position.units)
        position.units -= sold
      }
      positions.set(token, position)
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return [...positions.values()].filter((position) => position.units > 0n && position.costUsd > 0)
}

async function quoteSell(token: Address, amount: bigint) {
  try {
    const result = await publicClient.call({ account: account.address, to: FLIPT.router, data: encodeSell(token, amount) })
    return BigInt(result.data || '0x0')
  } catch {
    console.log(`[SELL]   skipped unquotable position: ${token}`)
    return 0n
  }
}

async function sellTrackedPosition(stats: Stats) {
  if (config.dryRun) return false
  for (const position of await loadCostPositions()) {
    const amount = position.units * BigInt(config.sellPercent) / 100n
    if (amount === 0n) continue
    const quotedOut = await quoteSell(position.token, amount)
    const costSliceUsd = position.costUsd * Number(amount) / Number(position.units)
    const targetOut = parseUnits((costSliceUsd * (1 + config.profitTargetPercent / 100)).toFixed(6), FLIPT.usdcDecimals)
    if (quotedOut < targetOut) continue
    const data = encodeSell(position.token, amount)
    const hash = await walletClient.sendTransaction({ to: FLIPT.router, data })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`Sell transaction failed: ${hash}`)
    const proceedsUsd = Number(formatUnits(quotedOut, FLIPT.usdcDecimals))
    await record(stats, 'sell', { token: position.token, tokenAmount: amount.toString(), costBasisUsd: Number(costSliceUsd.toFixed(6)), proceedsUsd, hash })
    console.log(`[SELL]   profit target met for ${position.token}: $${proceedsUsd.toFixed(2)} quoted, ${hash}`)
    return true
  }
  return false
}

async function closeLegacyPositions(stats: Stats) {
  if (config.dryRun || !config.closeLegacyPositions) return false

  const costTracked = new Set((await loadCostPositions()).map((position) => position.token.toLowerCase()))
  let closed = 0

  for (const token of trackedTokens) {
    if (closed >= config.maxLegacyClosesPerCycle) break
    if (costTracked.has(token.toLowerCase())) continue

    try {
      const balance = await tokenBalance(token)
      const amount = balance * BigInt(config.legacyClosePercent) / 100n
      if (amount === 0n) continue

      const quotedOut = await quoteSell(token, amount)
      if (quotedOut === 0n) continue

      const hash = await walletClient.sendTransaction({ to: FLIPT.router, data: encodeSell(token, amount) })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`Legacy close transaction failed: ${hash}`)

      const proceedsUsd = Number(formatUnits(quotedOut, FLIPT.usdcDecimals))
      await record(stats, 'sell', { token, tokenAmount: amount.toString(), proceedsUsd, reason: 'legacy-close', hash })
      console.log(`[SELL]   closed legacy position ${token}: ~$${proceedsUsd.toFixed(2)} quoted, ${hash}`)
      closed++
    } catch (error) {
      console.log(`[SELL]   could not close legacy position ${token}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return closed > 0
}
type BondPosition = { token: Address; lpToken: Address; cycle: number }

async function loadBondPositions(): Promise<BondPosition[]> {
  try {
    const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean)
    const positions: BondPosition[] = []
    for (const line of lines) {
      const event = JSON.parse(line) as { action?: string; token?: unknown; lpToken?: unknown; cycle?: unknown }
      if (event.action !== 'bond' || typeof event.token !== 'string' || typeof event.lpToken !== 'string') continue
      if (!/^0x[0-9a-fA-F]{40}$/.test(event.token) || !/^0x[0-9a-fA-F]{40}$/.test(event.lpToken)) continue
      positions.push({ token: getAddress(event.token), lpToken: getAddress(event.lpToken), cycle: typeof event.cycle === 'number' ? event.cycle : 0 })
    }
    return positions
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function mintedLpToken(receipt: { logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] }): Address | undefined {
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const zeroAddressTopic = `0x${''.padStart(64, '0')}`
  for (const log of receipt.logs) {
    const from = log.topics[1]?.toLowerCase()
    const to = log.topics[2]?.toLowerCase()
    if (log.topics[0]?.toLowerCase() !== transferTopic || from !== zeroAddressTopic || !to) continue
    if (`0x${to.slice(-40)}`.toLowerCase() !== account.address.toLowerCase()) continue
    if (BigInt(log.data) > 0n) return getAddress(log.address)
  }
}

async function bondTrackedPosition(stats: Stats) {
  if (config.dryRun || !config.autoBond) return false
  const positions = await loadBondPositions()
  const candidates = [...trackedTokens].sort(() => Math.random() - 0.5)

  for (const token of candidates.slice(0, 1)) {
    try {
      const priorPosition = positions.find((position) => position.token.toLowerCase() === token.toLowerCase())
      if (priorPosition && (await tokenBalance(priorPosition.lpToken)) > 0n) continue

      const balance = await tokenBalance(token)
      const tokenAmount = balance * BigInt(config.bondTokenPercent) / 100n
      if (tokenAmount === 0n) continue

      const usdcAvailable = await getFliptUsdcBalance(account.address)
      const usdcAmount = parseUnits(Math.min(config.maxBondUsdc, usdcAvailable).toFixed(6), FLIPT.usdcDecimals)
      if (usdcAmount === 0n) return false

      console.log(`[BOND]   testing ${token} with ${config.bondTokenPercent}% token balance and up to $${config.maxBondUsdc.toFixed(2)} USDC`)
      await ensureTokenAllowance(token, tokenAmount)
      await ensureUsdcAllowance(usdcAmount)
      const data = encodeBond(token, tokenAmount, usdcAmount)
      await publicClient.call({ account: account.address, to: FLIPT.router, data })
      const hash = await walletClient.sendTransaction({ to: FLIPT.router, data })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`Bond transaction failed: ${hash}`)

      const lpToken = mintedLpToken(receipt)
      if (!lpToken) throw new Error(`Bond succeeded but no LP mint was found in receipt: ${hash}`)
      await record(stats, 'bond', { token, lpToken, tokenAmount: tokenAmount.toString(), usdcAmount: usdcAmount.toString(), cycle: stats.cycles, hash })
      console.log(`[BOND]   bonded ${token}; LP position ${lpToken}: ${hash}`)
      return true
    } catch (error) {
      console.log(`[BOND]   skipped ${token}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return false
}

async function unbondMaturedPosition(stats: Stats) {
  if (config.dryRun || !config.autoUnbond) return false
  const positions = await loadBondPositions()
  const seen = new Set<string>()

  for (const position of positions) {
    if (seen.has(position.lpToken.toLowerCase()) || stats.cycles - position.cycle < config.unbondAfterCycles) continue
    seen.add(position.lpToken.toLowerCase())
    try {
      const lpBalance = await tokenBalance(position.lpToken)
      const liquidity = lpBalance * BigInt(config.unbondPercent) / 100n
      if (liquidity === 0n) continue

      console.log(`[UNBOND] removing ${config.unbondPercent}% of LP position ${position.lpToken}`)
      await ensureTokenAllowance(position.lpToken, liquidity)
      const data = encodeUnbond(position.token, liquidity)
      await publicClient.call({ account: account.address, to: FLIPT.router, data })
      const hash = await walletClient.sendTransaction({ to: FLIPT.router, data })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`Unbond transaction failed: ${hash}`)
      await record(stats, 'unbond', { token: position.token, lpToken: position.lpToken, liquidity: liquidity.toString(), hash })
      console.log(`[UNBOND] position closed: ${hash}`)
      return true
    } catch (error) {
      console.log(`[UNBOND] skipped ${position.token}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return false
}
async function createLaunch(stats: Stats) {
  const name = randomName()
  const symbol = randomSymbol(name)
  console.log(`\n[CREATE] ${name} ($${symbol})`)
  if (!config.dryRun) {
    const initialBuyUsd = randFloat(1.5, config.maxBuy)
    const initialBuy = parseUnits(initialBuyUsd.toFixed(2), FLIPT.usdcDecimals)
    console.log(`  -> finding a valid CREATE2 vanity salt for $${initialBuyUsd.toFixed(2)} initial buy...`)
    if (stats.spentUsd + initialBuyUsd > config.maxTotalSpend) {
      throw new Error(`MAX_TOTAL_SPEND_USDC (${config.maxTotalSpend}) reached before creating another launch.`)
    }
    const { salt, address } = await grindLaunchSalt(name, symbol)
    const iconUri = launchIconUri(name, symbol)
    const data = encodeCreate(name, symbol, iconUri, salt, initialBuy)
    await ensureUsdcAllowance(initialBuy)
    const simulation = await publicClient.call({ account: account.address, to: FLIPT.router, data })
    if (simulation.data && simulation.data.length >= 66) {
      const predicted = getAddress(`0x${simulation.data.slice(-40)}`)
      if (predicted !== address) throw new Error(`Create preflight returned ${predicted}, expected ${address}.`)
    }
    const hash = await walletClient.sendTransaction({ to: FLIPT.router, data })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`Launch transaction failed: ${hash}`)
    activeToken = address
    const acquired = await tokenBalance(address)
    await record(stats, 'create', { name, symbol, iconUri, token: address, salt, initialBuyUsd: Number(initialBuyUsd.toFixed(2)), tokenAmount: acquired.toString(), hash })
    stats.spentUsd += Number(initialBuyUsd.toFixed(2))
    trackedTokens = [...new Set([...trackedTokens, address])]
    createdTokens = [...new Set([...createdTokens, address])]
    console.log(`  -> created ${address}: ${hash}`)
    return
  }

  if (!config.dryRun) requireContractIntegration('createLaunch')

  await pause(4_000, 9_000)
  await record(stats, 'create', { name, symbol })
  console.log('  -> simulated create recorded')
}

async function buyOnCurve(stats: Stats, amountUsd: number) {
  console.log(`[BUY]    ~$${amountUsd.toFixed(2)}`)
  if (!config.dryRun) {
    if (stats.spentUsd + amountUsd > config.maxTotalSpend) {
      console.log(`[BUY]    spend cap reached; skipping this buy.`)
      return false
    }
    const amount = parseUnits(amountUsd.toFixed(2), FLIPT.usdcDecimals)
    await ensureUsdcAllowance(amount)
    for (const token of await discoverOtherLaunches()) {
      try {
        const balanceBefore = await tokenBalance(token)
        const data = encodeBuy(token, amount)
        await publicClient.call({ account: account.address, to: FLIPT.router, data })
        const hash = await walletClient.sendTransaction({ to: FLIPT.router, data })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error(`Buy transaction failed: ${hash}`)
        const acquired = (await tokenBalance(token)) - balanceBefore
        stats.spentUsd += Number(amountUsd.toFixed(2))
        await record(stats, 'buy', { token, amountUsd: Number(amountUsd.toFixed(2)), tokenAmount: acquired.toString(), hash })
        trackedTokens = [...new Set([...trackedTokens, token])]
        console.log(`  -> buy confirmed: ${hash}`)
        return true
      } catch {
        console.log(`  -> skipped non-buyable launch: ${token}`)
      }
    }
    console.log('  -> no currently buyable recent launch found; continuing cycle.')
    return false
  }

  if (!config.dryRun) requireContractIntegration('buyOnCurve')

  await pause(3_000, 7_000)
  await record(stats, 'buy', { amountUsd: Number(amountUsd.toFixed(2)) })
  console.log('  -> simulated buy recorded')
}

async function managePosition(stats: Stats) {
  if (!config.dryRun) {
    await collectCreatorRewards(stats)
    const closedLegacy = await closeLegacyPositions(stats)
    const soldForProfit = await sellTrackedPosition(stats)
    const unbonded = await unbondMaturedPosition(stats)
    const bonded = await bondTrackedPosition(stats)
    if (!closedLegacy && !soldForProfit && !unbonded && !bonded) await record(stats, 'hold')
    return
  }
  if (Math.random() > 0.65) {
    console.log('[UNBOND] simulated unbond')
    if (!config.dryRun) requireContractIntegration('managePosition')
    await pause(2_000, 5_000)
    await record(stats, 'unbond')
  } else {
    console.log('[HOLD]   staying bonded')
    await record(stats, 'hold')
  }
}

async function getBalance(address: Address) {
  const balance = await publicClient.getBalance({ address })
  return Number(formatUnits(balance, ARC.nativeCurrency.decimals))
}

async function getFliptUsdcBalance(address: Address) {
  const data = concatHex(['0x70a08231', encodeAbiParameters([{ type: 'address' }], [address])])
  const result = await publicClient.call({ to: FLIPT.usdc, data })
  return Number(formatUnits(BigInt(result.data || '0x0'), FLIPT.usdcDecimals))
}

async function main() {
  await mkdir(dataDir, { recursive: true })
  const stats = await loadStats()
  activeStats = stats
  await loadTrackedTokens()
  trackedTokens = [...new Set([...trackedTokens, FLIPT.defaultTarget])]
  createdTokens = [...new Set([...createdTokens, FLIPT.defaultTarget])]
  console.log('\nFlipt single-wallet runner')
  console.log(`Wallet: ${account.address}`)
  console.log(`Mode:   ${config.dryRun ? 'DRY RUN (no transactions)' : 'LIVE'}\n`)

  while (!stopping) {
    if (paused) {
      await sleep(1_000)
      continue
    }
    const [balance, fliptUsdc] = await Promise.all([getBalance(account.address), getFliptUsdcBalance(account.address)])
    stats.nativeGasUsdc = balance
    stats.fliptUsdc = fliptUsdc
    console.log(`Gas balance:   ${balance.toFixed(2)} native USDC`)
    console.log(`Flipt balance: ${fliptUsdc.toFixed(2)} USDC`)

    if (balance < config.minBalance) {
      console.log('Low balance. Claim test USDC at https://faucet.circle.com (select Arc Testnet).')
      await pause(5 * 60_000, 5 * 60_000)
      continue
    }

    await createLaunch(stats)
    await pause(20_000, 60_000)

    for (let index = 0; index < rand(1, 3) && !stopping; index += 1) {
      await buyOnCurve(stats, randFloat(1.5, config.maxBuy))
      await pause(15_000, 50_000)
    }

    if (!stopping) await managePosition(stats)
    stats.cycles += 1
    stats.updatedAt = new Date().toISOString()
    await writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`)
    console.log(`Cycle ${stats.cycles} done. Totals: ${stats.create} creates, ${stats.buy} buys.`)

    if (config.maxCycles > 0 && stats.cycles >= config.maxCycles) break
    const minutes = 1
    console.log(`Sleeping ${minutes} minute(s)...\n`)
    await pause(minutes * 60_000, minutes * 60_000)
  }
}

process.on('SIGINT', () => { stopping = true; console.log('\nStopping after the current operation...') })
process.on('SIGTERM', () => { stopping = true })

const servicePort = Number(process.env.PORT || 3001)
createServer((request, response) => {
  if (request.url === '/health' || request.url === '/status') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ ok: true, paused, stats: activeStats }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('Flipt bot is running. Use Telegram /status for details.\n')
}).listen(servicePort, () => console.log(`Health service: http://localhost:${servicePort}/health`))

void registerTelegramCommands()
void startTelegramPolling()
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

void walletClient
