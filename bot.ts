import 'dotenv/config'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ARC = {
  id: 5_042_002,
  name: 'Arc Testnet',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [
        process.env.RPC_URL || 'https://rpc.testnet.arc.io',
      ],
    },
  },
} as const

function required(name: string): string {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and set it.`,
    )
  }

  return value
}

function numberSetting(
  name: string,
  fallback: number,
  minimum = 0,
): number {
  const value = process.env[name]

  if (!value) return fallback

  const parsed = Number(value)

  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(
      `${name} must be a number greater than or equal to ${minimum}.`,
    )
  }

  return parsed
}

const config = {
  dryRun: process.env.DRY_RUN !== 'false',
  fastMode: process.env.FAST_MODE === 'true',

  minBalance: numberSetting(
    'MIN_BALANCE_USDC',
    3,
  ),

  maxBuy: numberSetting(
    'MAX_BUY_USDC',
    50,
    1,
  ),

  minBuy: numberSetting(
    'MIN_BUY_USDC',
    10,
    1,
  ),

  maxCycles: numberSetting(
    'MAX_CYCLES',
    0,
  ),

  maxTotalSpend: numberSetting(
    'MAX_TOTAL_SPEND_USDC',
    50,
    1,
  ),

  sellPercent: numberSetting(
    'SELL_PERCENT',
    25,
    1,
  ),

  profitTargetPercent: numberSetting(
    'PROFIT_TARGET_PERCENT',
    20,
    0,
  ),

  closeLegacyPositions:
    process.env.CLOSE_LEGACY_POSITIONS === 'true',

  legacyClosePercent: numberSetting(
    'LEGACY_CLOSE_PERCENT',
    100,
    1,
  ),

  maxLegacyClosesPerCycle: numberSetting(
    'MAX_LEGACY_CLOSES_PER_CYCLE',
    5,
    1,
  ),

  autoBond:
    process.env.AUTO_BOND === 'true',

  autoUnbond:
    process.env.AUTO_UNBOND === 'true',

  maxBondUsdc: numberSetting(
    'MAX_BOND_USDC',
    1,
    1,
  ),

  bondTokenPercent: numberSetting(
    'BOND_TOKEN_PERCENT',
    10,
    1,
  ),

  unbondPercent: numberSetting(
    'UNBOND_PERCENT',
    100,
    1,
  ),

  unbondAfterCycles: numberSetting(
    'UNBOND_AFTER_CYCLES',
    2,
    0,
  ),

  discoveryBlocks: numberSetting(
    'DISCOVERY_BLOCKS',
    5_000,
    100,
  ),

  // Every minute by default.
  maintenanceIntervalMs: numberSetting(
    'MAINTENANCE_INTERVAL_MS',
    60_000,
    10_000,
  ),

  // Historical creator-token discovery.
  creatorDiscoveryChunkBlocks: numberSetting(
    'CREATOR_DISCOVERY_CHUNK_BLOCKS',
    50_000,
    1_000,
  ),

  creatorDiscoveryLookbackBlocks: numberSetting(
    'CREATOR_DISCOVERY_LOOKBACK_BLOCKS',
    10_000_000,
    1_000,
  ),
}

if (
  config.maxBuy < 1.5 ||
  config.minBuy < 1.5
) {
  throw new Error(
    'Buy amounts must be at least 1.5 USDC.',
  )
}

if (config.maxBuy < config.minBuy) {
  throw new Error(
    'MAX_BUY_USDC must be at least MIN_BUY_USDC.',
  )
}

if (config.sellPercent > 100) {
  throw new Error(
    'SELL_PERCENT must not exceed 100.',
  )
}

if (config.legacyClosePercent > 100) {
  throw new Error(
    'LEGACY_CLOSE_PERCENT must not exceed 100.',
  )
}

if (
  config.bondTokenPercent > 100 ||
  config.unbondPercent > 100
) {
  throw new Error(
    'Bond and unbond percentages must not exceed 100.',
  )
}

const account = privateKeyToAccount(
  required('PRIVATE_KEY') as `0x${string}`,
)

const publicClient = createPublicClient({
  chain: ARC,
  transport: http(),
})

const walletClient = createWalletClient({
  account,
  chain: ARC,
  transport: http(),
})

const FLIPT = {
  router: '0x4b33146f2bcc75574534374c85662f9e51c38aca' as Address,
  lens: '0x6ab2635fec3c426d825d005e24cfc05b82ea3994' as Address,
  usdc: '0x4f3b8005d6b3f4994a791d971bcd153e114d20c2' as Address,

  createSelector: '0xe43d45f0' as Hex,
  buySelector: '0xc3b88b53' as Hex,
  sellSelector: '0x6a272462' as Hex,
  collectSelector: '0x06ec16f8' as Hex,

  launchEvent:
    '0x4b0d70e7e0cdb8221fc029a6d8b8df90893d2756ded597aeea9118a06a7e0e95' as Hex,

  defaultTarget:
    '0x05f2b07f2002f045a5eac3c067078bd6427b69d2' as Address,

  usdcDecimals: 6,
} as const

const FLIPT_ABI = [
  {
    type: 'function',
    name: 'graduationFactory',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        type: 'address',
      },
    ],
  },
] as const

const LENS_ABI = [
  {
    type: 'function',
    name: 'TOTAL_SUPPLY',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        type: 'uint256',
      },
    ],
  },
] as const

const GRADUATION_FACTORY_ABI = [
  {
    type: 'function',
    name: 'tokenInitCodeHash',
    stateMutability: 'view',
    inputs: [
      {
        type: 'string',
      },
      {
        type: 'string',
      },
      {
        type: 'uint256',
      },
    ],
    outputs: [
      {
        type: 'bytes32',
      },
    ],
  },

  {
    type: 'function',
    name: 'VANITY_MASK',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        type: 'uint256',
      },
    ],
  },

  {
    type: 'function',
    name: 'VANITY_SUFFIX',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        type: 'uint256',
      },
    ],
  },
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

const CREATE_ICON_URIS = (
  process.env.CREATE_ICON_URIS ??
  process.env.CREATE_ICON_URI ??
  ''
)
  .split(',')
  .map((uri) => uri.trim())
  .filter(Boolean)

const MIN_TOKENS_OUT = BigInt(
  process.env.MIN_TOKENS_OUT || '0',
)

const MIN_USDC_OUT = BigInt(
  process.env.MIN_USDC_OUT || '0',
)

const dataDir = path.resolve('data')
const eventsPath =
  path.join(dataDir, 'events.jsonl')
const statsPath =
  path.join(dataDir, 'stats.json')

type Action =
  | 'create'
  | 'buy'
  | 'sell'
  | 'bond'
  | 'collect'
  | 'unbond'
  | 'hold'

type Stats =
  Record<Action, number> & {
    cycles: number
    spentUsd: number
    nativeGasUsdc: number
    fliptUsdc: number
    creatorFeesUsd: number
    startedAt: string
    updatedAt: string
  }

type RunnerStage =
  | 'starting'
  | 'paused'
  | 'checking-balances'
  | 'creating'
  | 'buying'
  | 'managing'
  | 'sleeping'
  | 'backoff'
  | 'stopped'

type BondPosition = {
  token: Address
  lpToken: Address
  cycle: number
}

type CostPosition = {
  token: Address
  units: bigint
  costUsd: number
}

let activeToken: Address | undefined

let stopping = false
let paused = false

let trackedTokens: Address[] = []
let createdTokens: Address[] = []

let activeStats: Stats | undefined

let runnerAlive = false
let runnerStage: RunnerStage =
  'starting'

let lastRunnerActivityAt =
  new Date().toISOString()

let lastRunnerError:
  | string
  | undefined

let consecutiveRunnerErrors = 0

let maintenanceBusy = false

// Prevent the main trading loop and
// maintenance loop from broadcasting
// wallet transactions at the same time.
let txBusy = false

let creatorDiscoveryFromBlock:
  | bigint
  | undefined

const sleep = (
  ms: number,
) =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, ms),
  )

const rand = (
  min: number,
  max: number,
) =>
  Math.floor(
    Math.random() *
      (max - min + 1),
  ) + min

const randFloat = (
  min: number,
  max: number,
) =>
  Math.random() *
    (max - min) +
  min

const pause = async (
  minMs: number,
  maxMs: number,
) => {
  const multiplier =
    config.fastMode
      ? 0.02
      : 1

  await sleep(
    Math.round(
      rand(minMs, maxMs) *
        multiplier,
    ),
  )
}

const errorMessage = (
  error: unknown,
) =>
  error instanceof Error
    ? error.message
    : String(error)

function markRunner(
  stage: RunnerStage,
) {
  runnerStage = stage

  lastRunnerActivityAt =
    new Date().toISOString()
}

async function withTxLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  while (
    txBusy &&
    !stopping
  ) {
    await sleep(250)
  }

  if (stopping) {
    throw new Error(
      'Runner is stopping.',
    )
  }

  txBusy = true

  try {
    return await fn()
  } finally {
    txBusy = false
  }
}

function launchIconUri(
  name: string,
  symbol: string,
) {
  if (
    CREATE_ICON_URIS.length
  ) {
    return CREATE_ICON_URIS[
      rand(
        0,
        CREATE_ICON_URIS.length -
          1,
      )
    ]
  }

  return (
    'https://api.dicebear.com/9.x/identicon/png?' +
    `seed=${encodeURIComponent(
      `${name}-${symbol}`,
    )}&size=256`
  )
}

function encodeCreate(
  name: string,
  symbol: string,
  iconUri: string,
  salt: Hex,
  initialBuy: bigint,
): Hex {
  return concatHex([
    FLIPT.createSelector,

    encodeAbiParameters(
      CREATE_ARGUMENTS,
      [
        name,
        symbol,
        iconUri,
        salt,
        [],
        initialBuy,
        0n,
        0n,
      ],
    ),
  ])
}

function encodeBuy(
  token: Address,
  amount: bigint,
): Hex {
  return concatHex([
    FLIPT.buySelector,

    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        token,
        amount,
        MIN_TOKENS_OUT,
      ],
    ),
  ])
}

function encodeSell(
  token: Address,
  amount: bigint,
): Hex {
  return concatHex([
    FLIPT.sellSelector,

    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        token,
        amount,
        MIN_USDC_OUT,
      ],
    ),
  ])
}

function encodeCollect(
  token: Address,
): Hex {
  return concatHex([
    FLIPT.collectSelector,

    encodeAbiParameters(
      [
        {
          type: 'address',
        },
      ],
      [token],
    ),
  ])
}

function encodeBond(
  token: Address,
  tokenAmount: bigint,
  usdcAmount: bigint,
): Hex {
  const deadline =
    BigInt(
      Math.floor(
        Date.now() / 1_000,
      ) +
        10 * 60,
    )

  return concatHex([
    '0x2aaeb990',

    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],

      [
        token,
        tokenAmount,
        usdcAmount,
        0n,
        0n,
        0n,
        deadline,
      ],
    ),
  ])
}

function encodeUnbond(
  token: Address,
  liquidity: bigint,
): Hex {
  const deadline =
    BigInt(
      Math.floor(
        Date.now() / 1_000,
      ) +
        10 * 60,
    )

  return concatHex([
    '0x13928082',

    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],

      [
        token,
        liquidity,
        0n,
        0n,
        deadline,
      ],
    ),
  ])
}

async function ensureUsdcAllowance(
  requiredAmount: bigint,
) {
  const allowanceData =
    concatHex([
      '0xdd62ed3e',

      encodeAbiParameters(
        [
          {
            type: 'address',
          },

          {
            type: 'address',
          },
        ],

        [
          account.address,
          FLIPT.router,
        ],
      ),
    ])

  const allowanceResult =
    await publicClient.call({
      to: FLIPT.usdc,
      data: allowanceData,
    })

  if (
    BigInt(
      allowanceResult.data ||
        '0x0',
    ) >= requiredAmount
  ) {
    return
  }

  const approveData =
    concatHex([
      '0x095ea7b3',

      encodeAbiParameters(
        [
          {
            type: 'address',
          },

          {
            type: 'uint256',
          },
        ],

        [
          FLIPT.router,
          (1n << 256n) - 1n,
        ],
      ),
    ])

  await withTxLock(
    async () => {
      const hash =
        await walletClient.sendTransaction(
          {
            to: FLIPT.usdc,
            data: approveData,
          },
        )

      const receipt =
        await publicClient.waitForTransactionReceipt(
          {
            hash,
          },
        )

      if (
        receipt.status !==
        'success'
      ) {
        throw new Error(
          `USDC approval failed: ${hash}`,
        )
      }

      console.log(
        `  -> USDC approval confirmed: ${hash}`,
      )
    },
  )
}

async function ensureTokenAllowance(
  token: Address,
  requiredAmount: bigint,
) {
  const allowanceData =
    concatHex([
      '0xdd62ed3e',

      encodeAbiParameters(
        [
          {
            type: 'address',
          },

          {
            type: 'address',
          },
        ],

        [
          account.address,
          FLIPT.router,
        ],
      ),
    ])

  const allowanceResult =
    await publicClient.call({
      to: token,
      data: allowanceData,
    })

  if (
    BigInt(
      allowanceResult.data ||
        '0x0',
    ) >= requiredAmount
  ) {
    return
  }

  const approveData =
    concatHex([
      '0x095ea7b3',

      encodeAbiParameters(
        [
          {
            type: 'address',
          },

          {
            type: 'uint256',
          },
        ],

        [
          FLIPT.router,
          requiredAmount,
        ],
      ),
    ])

  await withTxLock(
    async () => {
      const hash =
        await walletClient.sendTransaction(
          {
            to: token,
            data: approveData,
          },
        )

      const receipt =
        await publicClient.waitForTransactionReceipt(
          {
            hash,
          },
        )

      if (
        receipt.status !==
        'success'
      ) {
        throw new Error(
          `Token approval failed: ${hash}`,
        )
      }

      console.log(
        `  -> token approval confirmed: ${hash}`,
      )
    },
  )
}

async function grindLaunchSalt(
  name: string,
  symbol: string,
): Promise<{
  salt: Hex
  address: Address
}> {
  const [
    graduationFactory,
    totalSupply,
  ] = await Promise.all([
    publicClient.readContract({
      address: FLIPT.router,
      abi: FLIPT_ABI,
      functionName:
        'graduationFactory',
    }),

    publicClient.readContract({
      address: FLIPT.lens,
      abi: LENS_ABI,
      functionName:
        'TOTAL_SUPPLY',
    }),
  ])

  const factory =
    graduationFactory as Address

  const [
    initCodeHash,
    mask,
    suffix,
  ] = await Promise.all([
    publicClient.readContract({
      address: factory,
      abi:
        GRADUATION_FACTORY_ABI,
      functionName:
        'tokenInitCodeHash',
      args: [
        name,
        symbol,
        totalSupply,
      ],
    }),

    publicClient.readContract({
      address: factory,
      abi:
        GRADUATION_FACTORY_ABI,
      functionName:
        'VANITY_MASK',
    }),

    publicClient.readContract({
      address: factory,
      abi:
        GRADUATION_FACTORY_ABI,
      functionName:
        'VANITY_SUFFIX',
    }),
  ])

  for (
    let counter = 0;
    counter <= 0xffff_ffff;
    counter += 1
  ) {
    const salt =
      toHex(
        counter,
        {
          size: 32,
        },
      )

    const saltHash =
      keccak256(
        encodeAbiParameters(
          [
            {
              type: 'address',
            },

            {
              type: 'bytes32',
            },
          ],

          [
            account.address,
            salt,
          ],
        ),
      )

    const hash =
      keccak256(
        concatHex([
          '0xff',
          factory,
          saltHash,
          initCodeHash,
        ]),
      )

    const token =
      getAddress(
        `0x${hash.slice(-40)}`,
      )

    if (
      (
        BigInt(
          `0x${token.slice(-4)}`,
        ) & mask
      ) ===
      (suffix & mask)
    ) {
      console.log(
        `  -> vanity salt found after ${counter.toLocaleString()} attempts`,
      )

      return {
        salt,
        address: token,
      }
    }

    if (
      counter > 0 &&
      counter % 2048 === 0
    ) {
      await sleep(0)
    }
  }

  throw new Error(
    'Unable to find an unused vanity salt.',
  )
}

function randomName() {
  const crypto = [
    'Satoshi',
    'Nakamoto',
    'Block',
    'Chain',
    'Ether',
    'Sol',
    'Axiom',
    'Nova',
    'Orbit',
    'Ledger',
    'Vault',
    'Cipher',
    'Quantum',
    'Helix',
    'Lumen',
  ]

  const launch = [
    'Fi',
    'Swap',
    'Protocol',
    'Network',
    'Vault',
    'Yield',
    'Pulse',
    'Capital',
    'Labs',
    'Node',
    'Bridge',
    'Forge',
    'Pay',
    'Stream',
    'Chain',
  ]

  return (
    crypto[
      rand(
        0,
        crypto.length - 1,
      )
    ] +
    launch[
      rand(
        0,
        launch.length - 1,
      )
    ]
  )
}

function randomSymbol(
  name: string,
) {
  const parts =
    name.match(
      /[A-Z][a-z]*/g,
    ) || [name]

  return parts
    .map(
      (part) =>
        part.slice(0, 3),
    )
    .join('')
    .toUpperCase()
    .slice(0, 5)
}

async function loadStats():
Promise<Stats> {
  const blank: Stats = {
    cycles: 0,
    spentUsd: 0,
    nativeGasUsdc: 0,
    fliptUsdc: 0,
    creatorFeesUsd: 0,

    create: 0,
    buy: 0,
    sell: 0,
    bond: 0,
    collect: 0,
    unbond: 0,
    hold: 0,

    startedAt:
      new Date().toISOString(),

    updatedAt:
      new Date().toISOString(),
  }

  try {
    return {
      ...blank,

      ...(
        JSON.parse(
          await readFile(
            statsPath,
            'utf8',
          ),
        ) as Partial<Stats>
      ),
    }
  } catch (
    error: unknown
  ) {
    if (
      (
        error as NodeJS.ErrnoException
      ).code === 'ENOENT'
    ) {
      return blank
    }

    throw error
  }
}

async function record(
  stats: Stats,
  action: Action,
  details:
    Record<
      string,
      unknown
    > = {},
) {
  if (
    action === 'collect' &&
    typeof details.creatorFeesUsd ===
      'number'
  ) {
    stats.creatorFeesUsd +=
      details.creatorFeesUsd
  }

  stats[action] += 1

  stats.updatedAt =
    new Date().toISOString()

  await Promise.all([
    appendFile(
      eventsPath,

      `${JSON.stringify({
        at:
          stats.updatedAt,

        action,

        dryRun:
          config.dryRun,

        ...details,
      })}\n`,
    ),

    writeFile(
      statsPath,

      `${JSON.stringify(
        stats,
        null,
        2,
      )}\n`,
    ),
  ])

  const token =
    typeof details.token ===
    'string'
      ? ` ${details.token}`
      : ''

  const amounts:
    string[] = []

  if (
    typeof details.amountUsd ===
    'number'
  ) {
    amounts.push(
      action === 'buy'
        ? `bought ${details.amountUsd.toFixed(
            2,
          )} USDC`
        : `${details.amountUsd.toFixed(
            2,
          )} USDC`,
    )
  }

  if (
    typeof details.proceedsUsd ===
    'number'
  ) {
    amounts.push(
      `sold ${details.proceedsUsd.toFixed(
        2,
      )} USDC`,
    )
  }

  if (
    typeof details.creatorFeesUsd ===
    'number'
  ) {
    amounts.push(
      `creator fees ${details.creatorFeesUsd.toFixed(
        6,
      )} USDC`,
    )
  }

  if (
    typeof details.initialBuyUsd ===
    'number'
  ) {
    amounts.push(
      `initial buy ${details.initialBuyUsd.toFixed(
        2,
      )} USDC`,
    )
  }

  if (
    typeof details.usdcAmount ===
    'string'
  ) {
    amounts.push(
      `liquidity ${Number(
        formatUnits(
          BigInt(
            details.usdcAmount,
          ),

          FLIPT.usdcDecimals,
        ),
      ).toFixed(2)} USDC`,
    )
  }

  const amountText =
    amounts.length
      ? ` — ${amounts.join(
          ', ',
        )}`
      : ''

  const hash =
    typeof details.hash ===
    'string'
      ? `\n${details.hash}`
      : ''

  void telegramNotify(
    `[${config.dryRun ? 'DRY' : 'LIVE'}] ${action}${token}${amountText}${hash}`,
  )
}

const telegramToken =
  process.env
    .TELEGRAM_BOT_TOKEN
    ?.trim()

const telegramChatId =
  process.env
    .TELEGRAM_CHAT_ID
    ?.trim()

async function telegramNotify(
  message: string,
) {
  if (
    !telegramToken ||
    !telegramChatId
  ) {
    return
  }

  try {
    await fetch(
      `https://api.telegram.org/bot${telegramToken}/sendMessage`,
      {
        method: 'POST',

        headers: {
          'content-type':
            'application/json',
        },

        body: JSON.stringify({
          chat_id:
            telegramChatId,

          text:
            message.slice(
              0,
              3900,
            ),

          disable_web_page_preview:
            true,
        }),
      },
    )
  } catch (error) {
    console.error(
      'Telegram notification failed:',
      error,
    )
  }
}

async function registerTelegramCommands() {
  if (!telegramToken) return

  try {
    await fetch(
      `https://api.telegram.org/bot${telegramToken}/setMyCommands`,
      {
        method: 'POST',

        headers: {
          'content-type':
            'application/json',
        },

        body: JSON.stringify({
          commands: [
            {
              command:
                'start',

              description:
                'Resume trading cycles',
            },

            {
              command:
                'resume',

              description:
                'Resume trading cycles',
            },

            {
              command:
                'pause',

              description:
                'Pause after current transaction',
            },

            {
              command:
                'stop',

              description:
                'Pause after current transaction',
            },

            {
              command:
                'status',

              description:
                'Show balances and totals',
            },

            {
              command:
                'help',

              description:
                'Show available commands',
            },
          ],
        }),
      },
    )
  } catch (error) {
    console.error(
      'Telegram command registration failed:',
      error,
    )
  }
}

function telegramStatus() {
  const stats =
    activeStats

  const state =
    stopping
      ? 'stopping'
      : !runnerAlive
        ? 'stopped'
        : paused
          ? 'paused'
          : `running (${runnerStage})`

  return [
    'Flipt Testnet bot',

    `State: ${state}`,

    `Last activity: ${lastRunnerActivityAt}`,

    ...(
      lastRunnerError
        ? [
            `Last runner error: ${lastRunnerError.slice(
              0,
              500,
            )}`,
          ]
        : []
    ),

    `Gas USDC: ${(stats?.nativeGasUsdc ?? 0).toFixed(
      2,
    )}`,

    `Flipt USDC: ${(stats?.fliptUsdc ?? 0).toFixed(
      2,
    )}`,

    `Cycles: ${stats?.cycles ?? 0}`,

    `Creates / buys / sells: ${stats?.create ?? 0} / ${stats?.buy ?? 0} / ${stats?.sell ?? 0}`,

    `Creator collections: ${stats?.collect ?? 0}`,

    `Creator fees claimed: ${(stats?.creatorFeesUsd ?? 0).toFixed(
      6,
    )} USDC`,

    `Creator tokens tracked: ${createdTokens.length}`,

    `Tracked spend: $${(stats?.spentUsd ?? 0).toFixed(
      2,
    )}`,
  ].join('\n')
}

async function startTelegramPolling() {
  if (
    !telegramToken ||
    !telegramChatId
  ) {
    console.log(
      'Telegram controls disabled.',
    )

    return
  }

  let offset = 0

  while (!stopping) {
    try {
      const response =
        await fetch(
          `https://api.telegram.org/bot${telegramToken}/getUpdates?timeout=25&offset=${offset}`,
        )

      const body =
        await response.json() as {
          ok?: boolean

          result?: Array<{
            update_id: number

            message?: {
              chat?: {
                id?:
                  | number
                  | string
              }

              text?: string
            }
          }>
        }

      if (
        !body.ok ||
        !body.result
      ) {
        continue
      }

      for (
        const update of
        body.result
      ) {
        offset =
          update.update_id + 1

        const message =
          update.message

        if (
          !message?.text ||
          String(
            message.chat?.id,
          ) !==
            telegramChatId
        ) {
          continue
        }

        const command =
          message.text
            .trim()
            .split(/\s+/)[0]
            .toLowerCase()
            .replace(
              /@[^\s]+$/,
              '',
            )

        if (
          command ===
            '/start' ||
          command ===
            '/resume'
        ) {
          paused = false

          await telegramNotify(
            `${runnerAlive ? 'Runner resumed.' : 'Runner is not active; restart the Render service.'}\n\n${telegramStatus()}`,
          )
        } else if (
          command ===
            '/pause' ||
          command ===
            '/stop'
        ) {
          paused = true

          await telegramNotify(
            'Runner paused after any in-flight transaction completes.',
          )
        } else if (
          command ===
          '/status'
        ) {
          await telegramNotify(
            telegramStatus(),
          )
        } else if (
          command ===
          '/help'
        ) {
          await telegramNotify(
            'Commands:\n/start or /resume — run cycles\n/pause or /stop — pause\n/status — balances and totals',
          )
        }
      }
    } catch (error) {
      console.error(
        'Telegram polling failed:',
        error,
      )

      await sleep(5_000)
    }
  }
}

async function loadTrackedTokens() {
  try {
    const lines =
      (
        await readFile(
          eventsPath,
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .filter(Boolean)

    const seen =
      new Set<Address>()

    const own =
      new Set<Address>()

    for (
      const line of lines
    ) {
      const event =
        JSON.parse(
          line,
        ) as {
          action?: string
          token?: unknown
        }

      if (
        typeof event.token !==
          'string' ||
        !/^0x[0-9a-fA-F]{40}$/.test(
          event.token,
        )
      ) {
        continue
      }

      const token =
        getAddress(
          event.token,
        )

      seen.add(token)

      if (
        event.action ===
          'create' ||
        event.action ===
          'creator-discovered'
      ) {
        own.add(token)
      }
    }

    trackedTokens =
      [...seen]

    createdTokens =
      [...own]
  } catch (
    error: unknown
  ) {
    if (
      (
        error as NodeJS.ErrnoException
      ).code !== 'ENOENT'
    ) {
      throw error
    }
  }
}

/*
  ============================================================
  HISTORICAL CREATOR TOKEN DISCOVERY
  ============================================================

  This scans Flipt launch events from Arc history.

  For every launch event:
    1. Get launch transaction.
    2. Check tx.from == THIS wallet.
    3. Check tx.to == Flipt router.
    4. Save the token permanently.

  This means old tokens created before the current Render
  deployment can be rediscovered from chain history.

  IMPORTANT:
  We do NOT remove tokens after collecting creator fees.
  They stay in createdTokens forever because they can generate
  more creator fees later.
*/

async function discoverCreatorTokensOnChain() {
  if (config.dryRun) {
    return
  }

  const latest =
    await publicClient.getBlockNumber()

  if (
    creatorDiscoveryFromBlock ===
    undefined
  ) {
    creatorDiscoveryFromBlock =
      latest >
      BigInt(
        config.creatorDiscoveryLookbackBlocks,
      )
        ? latest -
          BigInt(
            config.creatorDiscoveryLookbackBlocks,
          )
        : 0n
  }

  if (
    creatorDiscoveryFromBlock >
    latest
  ) {
    return
  }

  const chunk =
    BigInt(
      config.creatorDiscoveryChunkBlocks,
    )

  let fromBlock =
    creatorDiscoveryFromBlock

  let discovered = 0

  while (
    fromBlock <= latest &&
    !stopping
  ) {
    const candidateEnd =
      fromBlock +
      chunk -
      1n

    const toBlock =
      candidateEnd > latest
        ? latest
        : candidateEnd

    try {
      const logs =
        await publicClient.request({
          method:
            'eth_getLogs',

          params: [
            {
              address:
                FLIPT.router,

              fromBlock:
                toHex(
                  fromBlock,
                ),

              toBlock:
                toHex(
                  toBlock,
                ),

              topics: [
                FLIPT.launchEvent,
              ],
            },
          ],
        })

      for (
        const log of logs
      ) {
        const topic =
          log.topics[1]

        if (
          !topic ||
          !log.transactionHash
        ) {
          continue
        }

        try {
          const tx =
            await publicClient.getTransaction(
              {
                hash:
                  log.transactionHash,
              },
            )

          if (
            tx.from.toLowerCase() !==
            account.address.toLowerCase()
          ) {
            continue
          }

          if (
            !tx.to ||
            tx.to.toLowerCase() !==
              FLIPT.router.toLowerCase()
          ) {
            continue
          }

          const token =
            getAddress(
              `0x${topic.slice(
                -40,
              )}`,
            )

          const alreadyKnown =
            createdTokens.some(
              (known) =>
                known.toLowerCase() ===
                token.toLowerCase(),
            )

          createdTokens = [
            ...new Set([
              ...createdTokens,
              token,
            ]),
          ]

          trackedTokens = [
            ...new Set([
              ...trackedTokens,
              token,
            ]),
          ]

          if (
            !alreadyKnown
          ) {
            discovered++

            const at =
              new Date().toISOString()

            await appendFile(
              eventsPath,

              `${JSON.stringify({
                at,

                action:
                  'creator-discovered',

                dryRun:
                  false,

                token,

                transactionHash:
                  log.transactionHash,

                blockNumber:
                  log.blockNumber?.toString(),
              })}\n`,
            )

            console.log(
              `[DISCOVERY] historical creator token: ${token}`,
            )
          }
        } catch (error) {
          console.log(
            `[DISCOVERY] could not inspect launch tx ${log.transactionHash}: ${errorMessage(
              error,
            )}`,
          )
        }
      }

      creatorDiscoveryFromBlock =
        toBlock + 1n

      fromBlock =
        toBlock + 1n
    } catch (error) {
      console.log(
        `[DISCOVERY] blocks ${fromBlock}-${toBlock} failed: ${errorMessage(
          error,
        )}`,
      )

      // Do NOT move the cursor.
      // Retry this range next time.
      break
    }
  }

  if (
    discovered > 0
  ) {
    console.log(
      `[DISCOVERY] added ${discovered} creator token(s); total creator tokens: ${createdTokens.length}`,
    )

    void telegramNotify(
      `[DISCOVERY] Found ${discovered} historical creator token(s). Total tracked creator tokens: ${createdTokens.length}`,
    )
  }
}

async function discoverOtherLaunches():
Promise<Address[]> {
  const latest =
    await publicClient.getBlockNumber()

  const fromBlock =
    latest >
    BigInt(
      config.discoveryBlocks,
    )
      ? latest -
        BigInt(
          config.discoveryBlocks,
        )
      : 0n

  const logs =
    await publicClient.request({
      method:
        'eth_getLogs',

      params: [
        {
          address:
            FLIPT.router,

          fromBlock:
            toHex(
              fromBlock,
            ),

          toBlock:
            'latest',

          topics: [
            FLIPT.launchEvent,
          ],
        },
      ],
    })

  const candidates =
    logs.flatMap(
      (log) => {
        const topic =
          log.topics[1]

        if (!topic) {
          return []
        }

        const token =
          getAddress(
            `0x${topic.slice(
              -40,
            )}`,
          )

        return (
          token ===
            FLIPT.defaultTarget ||
          token ===
            activeToken
        )
          ? []
          : [token]
      },
    )

  return [
    ...new Set(
      candidates,
    ),
  ]
    .sort(
      () =>
        Math.random() -
        0.5,
    )
    .slice(0, 12)
}

async function tokenBalance(
  token: Address,
): Promise<bigint> {
  const data =
    concatHex([
      '0x70a08231',

      encodeAbiParameters(
        [
          {
            type: 'address',
          },
        ],

        [
          account.address,
        ],
      ),
    ])

  const result =
    await publicClient.call({
      to: token,
      data,
    })

  return BigInt(
    result.data || '0x0',
  )
}

async function getBalance(
  address: Address,
) {
  return Number(
    formatUnits(
      await publicClient.getBalance(
        {
          address,
        },
      ),

      ARC.nativeCurrency
        .decimals,
    ),
  )
}

async function getFliptUsdcBalance(
  address: Address,
) {
  const data =
    concatHex([
      '0x70a08231',

      encodeAbiParameters(
        [
          {
            type: 'address',
          },
        ],

        [address],
      ),
    ])

  const result =
    await publicClient.call({
      to: FLIPT.usdc,
      data,
    })

  return Number(
    formatUnits(
      BigInt(
        result.data ||
          '0x0',
      ),

      FLIPT.usdcDecimals,
    ),
  )
}

/*
  ============================================================
  CREATOR FEE AUTO CLAIM
  ============================================================

  Checks EVERY old + new creator token.

  Simulation tells us the amount claimable.

  If 0:
    SKIP transaction.

  If > 0:
    claim.

  Token remains tracked afterward.

  Next minute it is checked again.
*/

async function collectCreatorRewards(
  stats: Stats,
) {
  if (
    config.dryRun ||
    createdTokens.length === 0
  ) {
    return
  }

  console.log(
    `[COLLECT] checking ${createdTokens.length} creator token(s)...`,
  )

  for (
    const token of
    [...createdTokens]
  ) {
    if (stopping) {
      return
    }

    try {
      const data =
        encodeCollect(token)

      const simulation =
        await publicClient.call({
          account:
            account.address,

          to:
            FLIPT.router,

          data,
        })

      const claimableRaw =
        BigInt(
          simulation.data ||
            '0x0',
        )

      if (
        claimableRaw === 0n
      ) {
        continue
      }

      const claimableUsd =
        Number(
          formatUnits(
            claimableRaw,

            FLIPT.usdcDecimals,
          ),
        )

      console.log(
        `[COLLECT] ${token} has ${claimableUsd.toFixed(
          6,
        )} USDC claimable`,
      )

      const before =
        await getFliptUsdcBalance(
          account.address,
        )

      const hash =
        await withTxLock(
          () =>
            walletClient.sendTransaction(
              {
                to:
                  FLIPT.router,

                data,
              },
            ),
        )

      const receipt =
        await publicClient.waitForTransactionReceipt(
          {
            hash,
          },
        )

      if (
        receipt.status !==
        'success'
      ) {
        throw new Error(
          `Collect transaction failed: ${hash}`,
        )
      }

      const after =
        await getFliptUsdcBalance(
          account.address,
        )

      const receivedUsd =
        Math.max(
          0,
          after - before,
        )

      const creatorFeesUsd =
        receivedUsd > 0
          ? receivedUsd
          : claimableUsd

      await record(
        stats,
        'collect',
        {
          token,

          creatorFeesUsd:
            Number(
              creatorFeesUsd.toFixed(
                6,
              ),
            ),

          claimableUsd:
            Number(
              claimableUsd.toFixed(
                6,
              ),
            ),

          hash,
        },
      )

      console.log(
        `[COLLECT] ${token}: ${creatorFeesUsd.toFixed(
          6,
        )} USDC claimed`,
      )
    } catch (error) {
      console.log(
        `[COLLECT] ${token} skipped: ${errorMessage(
          error,
        )}`,
      )
    }
  }
}

async function loadCostPositions():
Promise<CostPosition[]> {
  const positions =
    new Map<
      Address,
      CostPosition
    >()

  try {
    const lines =
      (
        await readFile(
          eventsPath,
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .filter(Boolean)

    for (
      const line of lines
    ) {
      const event =
        JSON.parse(
          line,
        ) as {
          action?: string
          token?: unknown
          tokenAmount?: unknown
          amountUsd?: unknown
          initialBuyUsd?: unknown
        }

      if (
        typeof event.token !==
          'string' ||
        !/^0x[0-9a-fA-F]{40}$/.test(
          event.token,
        ) ||
        typeof event.tokenAmount !==
          'string'
      ) {
        continue
      }

      const token =
        getAddress(
          event.token,
        )

      const units =
        BigInt(
          event.tokenAmount,
        )

      const position =
        positions.get(
          token,
        ) ?? {
          token,
          units: 0n,
          costUsd: 0,
        }

      if (
        event.action ===
          'buy' ||
        event.action ===
          'create'
      ) {
        const costUsd =
          Number(
            event.amountUsd ??
              event.initialBuyUsd ??
              0,
          )

        if (
          Number.isFinite(
            costUsd,
          ) &&
          costUsd > 0 &&
          units > 0n
        ) {
          position.units +=
            units

          position.costUsd +=
            costUsd
        }
      } else if (
        event.action ===
          'sell' &&
        units > 0n &&
        position.units > 0n
      ) {
        const sold =
          units >
          position.units
            ? position.units
            : units

        position.costUsd *=
          Number(
            position.units -
              sold,
          ) /
          Number(
            position.units,
          )

        position.units -=
          sold
      }

      positions.set(
        token,
        position,
      )
    }
  } catch (
    error: unknown
  ) {
    if (
      (
        error as NodeJS.ErrnoException
      ).code !== 'ENOENT'
    ) {
      throw error
    }
  }

  return [
    ...positions.values(),
  ].filter(
    (position) =>
      position.units > 0n &&
      position.costUsd > 0,
  )
}

async function quoteSell(
  token: Address,
  amount: bigint,
) {
  try {
    const result =
      await publicClient.call({
        account:
          account.address,

        to:
          FLIPT.router,

        data:
          encodeSell(
            token,
            amount,
          ),
      })

    return BigInt(
      result.data ||
        '0x0',
    )
  } catch {
    return 0n
  }
}

async function sellTrackedPosition(
  stats: Stats,
) {
  if (config.dryRun) {
    return false
  }

  for (
    const position of
    await loadCostPositions()
  ) {
    const amount =
      position.units *
      BigInt(
        config.sellPercent,
      ) /
      100n

    if (!amount) {
      continue
    }

    const quotedOut =
      await quoteSell(
        position.token,
        amount,
      )

    const costSliceUsd =
      position.costUsd *
      Number(amount) /
      Number(
        position.units,
      )

    const targetOut =
      parseUnits(
        (
          costSliceUsd *
          (
            1 +
            config.profitTargetPercent /
              100
          )
        ).toFixed(6),

        FLIPT.usdcDecimals,
      )

    if (
      quotedOut <
      targetOut
    ) {
      continue
    }

    const hash =
      await withTxLock(
        () =>
          walletClient.sendTransaction(
            {
              to:
                FLIPT.router,

              data:
                encodeSell(
                  position.token,
                  amount,
                ),
            },
          ),
      )

    const receipt =
      await publicClient.waitForTransactionReceipt(
        {
          hash,
        },
      )

    if (
      receipt.status !==
      'success'
    ) {
      throw new Error(
        `Sell transaction failed: ${hash}`,
      )
    }

    const proceedsUsd =
      Number(
        formatUnits(
          quotedOut,

          FLIPT.usdcDecimals,
        ),
      )

    await record(
      stats,
      'sell',
      {
        token:
          position.token,

        tokenAmount:
          amount.toString(),

        costBasisUsd:
          Number(
            costSliceUsd.toFixed(
              6,
            ),
          ),

        proceedsUsd,

        hash,
      },
    )

    return true
  }

  return false
}

async function closeLegacyPositions(
  stats: Stats,
) {
  if (
    config.dryRun ||
    !config.closeLegacyPositions
  ) {
    return false
  }

  const costTracked =
    new Set(
      (
        await loadCostPositions()
      ).map(
        (position) =>
          position.token.toLowerCase(),
      ),
    )

  let closed = 0

  for (
    const token of
    trackedTokens
  ) {
    if (
      closed >=
      config.maxLegacyClosesPerCycle
    ) {
      break
    }

    if (
      costTracked.has(
        token.toLowerCase(),
      )
    ) {
      continue
    }

    try {
      const balance =
        await tokenBalance(
          token,
        )

      const amount =
        balance *
        BigInt(
          config.legacyClosePercent,
        ) /
        100n

      if (!amount) {
        continue
      }

      const quotedOut =
        await quoteSell(
          token,
          amount,
        )

      if (!quotedOut) {
        continue
      }

      const hash =
        await withTxLock(
          () =>
            walletClient.sendTransaction(
              {
                to:
                  FLIPT.router,

                data:
                  encodeSell(
                    token,
                    amount,
                  ),
              },
            ),
        )

      const receipt =
        await publicClient.waitForTransactionReceipt(
          {
            hash,
          },
        )

      if (
        receipt.status !==
        'success'
      ) {
        throw new Error(
          `Legacy close failed: ${hash}`,
        )
      }

      await record(
        stats,
        'sell',
        {
          token,

          tokenAmount:
            amount.toString(),

          proceedsUsd:
            Number(
              formatUnits(
                quotedOut,

                FLIPT.usdcDecimals,
              ),
            ),

          reason:
            'legacy-close',

          hash,
        },
      )

      closed++
    } catch (error) {
      console.log(
        `[SELL] legacy ${token}: ${errorMessage(
          error,
        )}`,
      )
    }
  }

  return closed > 0
}

async function loadBondPositions():
Promise<BondPosition[]> {
  try {
    const lines =
      (
        await readFile(
          eventsPath,
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .filter(Boolean)

    const positions:
      BondPosition[] = []

    for (
      const line of lines
    ) {
      const event =
        JSON.parse(
          line,
        ) as {
          action?: string
          token?: unknown
          lpToken?: unknown
          cycle?: unknown
        }

      if (
        event.action !==
          'bond' ||
        typeof event.token !==
          'string' ||
        typeof event.lpToken !==
          'string'
      ) {
        continue
      }

      if (
        !/^0x[0-9a-fA-F]{40}$/.test(
          event.token,
        ) ||
        !/^0x[0-9a-fA-F]{40}$/.test(
          event.lpToken,
        )
      ) {
        continue
      }

      positions.push({
        token:
          getAddress(
            event.token,
          ),

        lpToken:
          getAddress(
            event.lpToken,
          ),

        cycle:
          typeof event.cycle ===
          'number'
            ? event.cycle
            : 0,
      })
    }

    return positions
  } catch (
    error: unknown
  ) {
    if (
      (
        error as NodeJS.ErrnoException
      ).code === 'ENOENT'
    ) {
      return []
    }

    throw error
  }
}

function mintedLpToken(
  receipt: {
    logs:
      readonly {
        address: Address
        data: Hex
        topics:
          readonly Hex[]
      }[]
  },
):
  | Address
  | undefined {
  const transferTopic =
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

  const zeroAddressTopic =
    `0x${''.padStart(
      64,
      '0',
    )}`

  for (
    const log of
    receipt.logs
  ) {
    const from =
      log.topics[1]
        ?.toLowerCase()

    const to =
      log.topics[2]
        ?.toLowerCase()

    if (
      log.topics[0]
        ?.toLowerCase() !==
        transferTopic ||
      from !==
        zeroAddressTopic ||
      !to
    ) {
      continue
    }

    if (
      `0x${to.slice(
        -40,
      )}`.toLowerCase() !==
      account.address.toLowerCase()
    ) {
      continue
    }

    if (
      BigInt(
        log.data,
      ) > 0n
    ) {
      return getAddress(
        log.address,
      )
    }
  }
}

/*
  ============================================================
  AUTO BOND
  ============================================================

  Checks ALL historical + new tracked tokens.

  If a token already has a live LP position:
      skip.

  Otherwise if wallet has token balance:
      try bond.

  It runs again next minute, so old tokens can become
  eligible later.
*/

async function bondAllEligiblePositions(
  stats: Stats,
) {
  if (
    config.dryRun ||
    !config.autoBond
  ) {
    return false
  }

  const positions =
    await loadBondPositions()

  const candidates = [
    ...new Set([
      ...createdTokens,
      ...trackedTokens,
    ]),
  ]

  let didSomething =
    false

  for (
    const token of
    candidates
  ) {
    if (stopping) {
      return didSomething
    }

    try {
      const prior =
        positions.filter(
          (position) =>
            position.token.toLowerCase() ===
            token.toLowerCase(),
        )

      let alreadyBonded =
        false

      for (
        const position of
        prior
      ) {
        const lpBalance =
          await tokenBalance(
            position.lpToken,
          )

        if (
          lpBalance > 0n
        ) {
          alreadyBonded =
            true

          break
        }
      }

      if (
        alreadyBonded
      ) {
        continue
      }

      const balance =
        await tokenBalance(
          token,
        )

      const tokenAmount =
        balance *
        BigInt(
          config.bondTokenPercent,
        ) /
        100n

      if (!tokenAmount) {
        continue
      }

      const usdcAvailable =
        await getFliptUsdcBalance(
          account.address,
        )

      const usdcAmount =
        parseUnits(
          Math.min(
            config.maxBondUsdc,
            usdcAvailable,
          ).toFixed(6),

          FLIPT.usdcDecimals,
        )

      if (!usdcAmount) {
        continue
      }

      await ensureTokenAllowance(
        token,
        tokenAmount,
      )

      await ensureUsdcAllowance(
        usdcAmount,
      )

      const data =
        encodeBond(
          token,
          tokenAmount,
          usdcAmount,
        )

      // Preflight.
      await publicClient.call({
        account:
          account.address,

        to:
          FLIPT.router,

        data,
      })

      const hash =
        await withTxLock(
          () =>
            walletClient.sendTransaction(
              {
                to:
                  FLIPT.router,

                data,
              },
            ),
        )

      const receipt =
        await publicClient.waitForTransactionReceipt(
          {
            hash,
          },
        )

      if (
        receipt.status !==
        'success'
      ) {
        throw new Error(
          `Bond transaction failed: ${hash}`,
        )
      }

      const lpToken =
        mintedLpToken(
          receipt,
        )

      if (!lpToken) {
        throw new Error(
          `Bond succeeded but no LP mint found: ${hash}`,
        )
      }

      await record(
        stats,
        'bond',
        {
          token,

          lpToken,

          tokenAmount:
            tokenAmount.toString(),

          usdcAmount:
            usdcAmount.toString(),

          cycle:
            stats.cycles,

          hash,
        },
      )

      positions.push({
        token,
        lpToken,
        cycle:
          stats.cycles,
      })

      didSomething =
        true
    } catch (error) {
      console.log(
        `[BOND] ${token} skipped: ${errorMessage(
          error,
        )}`,
      )
    }
  }

  return didSomething
}

/*
  ============================================================
  AUTO UNBOND
  ============================================================

  Checks EVERY historical LP position every minute.

  If LP balance is zero:
      skip.

  If position is mature:
      unbond configured percentage.

  If it has remaining LP after partial unbond:
      next minute it can be checked again.
*/

async function unbondAllMaturedPositions(
  stats: Stats,
) {
  if (
    config.dryRun ||
    !config.autoUnbond
  ) {
    return false
  }

  const positions =
    await loadBondPositions()

  const seen =
    new Set<string>()

  let didSomething =
    false

  for (
    const position of
    positions
  ) {
    const key =
      position.lpToken.toLowerCase()

    if (
      seen.has(key)
    ) {
      continue
    }

    seen.add(key)

    if (
      stats.cycles -
        position.cycle <
      config.unbondAfterCycles
    ) {
      continue
    }

    try {
      const lpBalance =
        await tokenBalance(
          position.lpToken,
        )

      const liquidity =
        lpBalance *
        BigInt(
          config.unbondPercent,
        ) /
        100n

      if (!liquidity) {
        continue
      }

      await ensureTokenAllowance(
        position.lpToken,
        liquidity,
      )

      const data =
        encodeUnbond(
          position.token,
          liquidity,
        )

      await publicClient.call({
        account:
          account.address,

        to:
          FLIPT.router,

        data,
      })

      const hash =
        await withTxLock(
          () =>
            walletClient.sendTransaction(
              {
                to:
                  FLIPT.router,

                data,
              },
            ),
        )

      const receipt =
        await publicClient.waitForTransactionReceipt(
          {
            hash,
          },
        )

      if (
        receipt.status !==
        'success'
      ) {
        throw new Error(
          `Unbond transaction failed: ${hash}`,
        )
      }

      await record(
        stats,
        'unbond',
        {
          token:
            position.token,

          lpToken:
            position.lpToken,

          liquidity:
            liquidity.toString(),

          hash,
        },
      )

      didSomething =
        true
    } catch (error) {
      console.log(
        `[UNBOND] ${position.token} skipped: ${errorMessage(
          error,
        )}`,
      )
    }
  }

  return didSomething
}

/*
  ============================================================
  ONE-MINUTE MAINTENANCE
  ============================================================

  Every minute:

    1. Discover newly-created wallet launches from chain.
    2. Check ALL old/new creator tokens for fees.
    3. Check ALL historical LPs for unbond.
    4. Check ALL eligible tokens for bond.

  This runs independently of CREATE/BUY trading cycles.
*/

async function maintenancePass(
  stats: Stats,
) {
  if (
    maintenanceBusy ||
    config.dryRun
  ) {
    return
  }

  maintenanceBusy = true

  try {
    await discoverCreatorTokensOnChain()

    await collectCreatorRewards(
      stats,
    )

    await unbondAllMaturedPositions(
      stats,
    )

    await bondAllEligiblePositions(
      stats,
    )
  } catch (error) {
    console.error(
      '[MAINTENANCE]',
      error,
    )
  } finally {
    maintenanceBusy = false
  }
}

async function maintenanceLoop() {
  while (!stopping) {
    if (
      !paused &&
      activeStats
    ) {
      await maintenancePass(
        activeStats,
      )
    }

    await sleep(
      config.maintenanceIntervalMs,
    )
  }
}

async function createLaunch(
  stats: Stats,
) {
  const name =
    randomName()

  const symbol =
    randomSymbol(name)

  console.log(
    `\n[CREATE] ${name} ($${symbol})`,
  )

  if (!config.dryRun) {
    const initialBuyUsd =
      randFloat(
        1.5,
        config.maxBuy,
      )

    if (
      stats.spentUsd +
        initialBuyUsd >
      config.maxTotalSpend
    ) {
      throw new Error(
        `MAX_TOTAL_SPEND_USDC (${config.maxTotalSpend}) reached before creating another launch.`,
      )
    }

    const initialBuy =
      parseUnits(
        initialBuyUsd.toFixed(
          2,
        ),

        FLIPT.usdcDecimals,
      )

    const {
      salt,
      address,
    } =
      await grindLaunchSalt(
        name,
        symbol,
      )

    const iconUri =
      launchIconUri(
        name,
        symbol,
      )

    const data =
      encodeCreate(
        name,
        symbol,
        iconUri,
        salt,
        initialBuy,
      )

    await ensureUsdcAllowance(
      initialBuy,
    )

    const simulation =
      await publicClient.call({
        account:
          account.address,

        to:
          FLIPT.router,

        data,
      })

    if (
      simulation.data &&
      simulation.data.length >=
        66
    ) {
      const predicted =
        getAddress(
          `0x${simulation.data.slice(
            -40,
          )}`,
        )

      if (
        predicted !==
        address
      ) {
        throw new Error(
          `Create preflight returned ${predicted}, expected ${address}.`,
        )
      }
    }

    const hash =
      await withTxLock(
        () =>
          walletClient.sendTransaction(
            {
              to:
                FLIPT.router,

              data,
            },
          ),
      )

    const receipt =
      await publicClient.waitForTransactionReceipt(
        {
          hash,
        },
      )

    if (
      receipt.status !==
      'success'
    ) {
      throw new Error(
        `Launch transaction failed: ${hash}`,
      )
    }

    activeToken =
      address

    const acquired =
      await tokenBalance(
        address,
      )

    stats.spentUsd +=
      Number(
        initialBuyUsd.toFixed(
          2,
        ),
      )

    await record(
      stats,
      'create',
      {
        name,
        symbol,
        iconUri,

        token:
          address,

        salt,

        initialBuyUsd:
          Number(
            initialBuyUsd.toFixed(
              2,
            ),
          ),

        tokenAmount:
          acquired.toString(),

        hash,
      },
    )

    trackedTokens = [
      ...new Set([
        ...trackedTokens,
        address,
      ]),
    ]

    createdTokens = [
      ...new Set([
        ...createdTokens,
        address,
      ]),
    ]

    return
  }

  await pause(
    4_000,
    9_000,
  )

  await record(
    stats,
    'create',
    {
      name,
      symbol,
    },
  )
}

async function buyOnCurve(
  stats: Stats,
  amountUsd: number,
) {
  if (!config.dryRun) {
    if (
      stats.spentUsd +
        amountUsd >
      config.maxTotalSpend
    ) {
      return false
    }

    const availableUsd =
      await getFliptUsdcBalance(
        account.address,
      )

    const spendableUsd =
      Math.max(
        0,
        availableUsd - 0.1,
      )

    if (
      spendableUsd < 1.5
    ) {
      return false
    }

    amountUsd =
      Math.min(
        amountUsd,
        spendableUsd,
      )

    const amount =
      parseUnits(
        amountUsd.toFixed(
          2,
        ),

        FLIPT.usdcDecimals,
      )

    await ensureUsdcAllowance(
      amount,
    )

    for (
      const token of
      await discoverOtherLaunches()
    ) {
      try {
        const before =
          await tokenBalance(
            token,
          )

        const data =
          encodeBuy(
            token,
            amount,
          )

        await publicClient.call({
          account:
            account.address,

          to:
            FLIPT.router,

          data,
        })

        const hash =
          await withTxLock(
            () =>
              walletClient.sendTransaction(
                {
                  to:
                    FLIPT.router,

                  data,
                },
              ),
          )

        const receipt =
          await publicClient.waitForTransactionReceipt(
            {
              hash,
            },
          )

        if (
          receipt.status !==
          'success'
        ) {
          throw new Error(
            `Buy transaction failed: ${hash}`,
          )
        }

        const acquired =
          (
            await tokenBalance(
              token,
            )
          ) - before

        stats.spentUsd +=
          Number(
            amountUsd.toFixed(
              2,
            ),
          )

        await record(
          stats,
          'buy',
          {
            token,

            amountUsd:
              Number(
                amountUsd.toFixed(
                  2,
                ),
              ),

            tokenAmount:
              acquired.toString(),

            hash,
          },
        )

        trackedTokens = [
          ...new Set([
            ...trackedTokens,
            token,
          ]),
        ]

        return true
      } catch {
        console.log(
          `  -> skipped non-buyable launch: ${token}`,
        )
      }
    }

    return false
  }

  await pause(
    3_000,
    7_000,
  )

  await record(
    stats,
    'buy',
    {
      amountUsd:
        Number(
          amountUsd.toFixed(
            2,
          ),
        ),
    },
  )

  return true
}

async function managePosition(
  stats: Stats,
) {
  if (!config.dryRun) {
    const closedLegacy =
      await closeLegacyPositions(
        stats,
      )

    const soldForProfit =
      await sellTrackedPosition(
        stats,
      )

    if (
      !closedLegacy &&
      !soldForProfit
    ) {
      await record(
        stats,
        'hold',
      )
    }

    return
  }

  await record(
    stats,
    'hold',
  )
}

async function main() {
  await mkdir(
    dataDir,
    {
      recursive: true,
    },
  )

  const stats =
    await loadStats()

  activeStats =
    stats

  await loadTrackedTokens()

  /*
    defaultTarget can remain a tradable target.

    DO NOT put defaultTarget into createdTokens unless
    this wallet actually created it.
  */

  trackedTokens = [
    ...new Set([
      ...trackedTokens,
      FLIPT.defaultTarget,
    ]),
  ]

  createdTokens = [
    ...new Set(
      createdTokens,
    ),
  ]

  console.log(
    '[DISCOVERY] scanning Arc history for launches created by this wallet...',
  )

  /*
    On startup, reconstruct historical creator launches
    before beginning normal cycles.

    This is what allows creator fees from old launches to
    be collected even after a Render redeploy.
  */

  await discoverCreatorTokensOnChain()

  runnerAlive = true

  markRunner(
    'checking-balances',
  )

  console.log(
    '\nFlipt single-wallet runner',
  )

  console.log(
    `Wallet: ${account.address}`,
  )

  console.log(
    `Mode:   ${config.dryRun ? 'DRY RUN' : 'LIVE'}`,
  )

  console.log(
    `Historical creator tokens loaded: ${createdTokens.length}\n`,
  )

  while (!stopping) {
    if (paused) {
      markRunner(
        'paused',
      )

      await sleep(
        1_000,
      )

      continue
    }

    try {
      markRunner(
        'checking-balances',
      )

      const [
        balance,
        fliptUsdc,
      ] =
        await Promise.all([
          getBalance(
            account.address,
          ),

          getFliptUsdcBalance(
            account.address,
          ),
        ])

      stats.nativeGasUsdc =
        balance

      stats.fliptUsdc =
        fliptUsdc

      if (
        balance <
        config.minBalance
      ) {
        markRunner(
          'sleeping',
        )

        await sleep(
          5 * 60_000,
        )

        continue
      }

      markRunner(
        'creating',
      )

      await createLaunch(
        stats,
      )

      if (
        paused ||
        stopping
      ) {
        continue
      }

      await pause(
        20_000,
        60_000,
      )

      const buyCount =
        rand(1, 3)

      for (
        let index = 0;
        index < buyCount &&
        !stopping &&
        !paused;
        index++
      ) {
        markRunner(
          'buying',
        )

        try {
          await buyOnCurve(
            stats,

            randFloat(
              config.minBuy,
              config.maxBuy,
            ),
          )
        } catch (error) {
          console.error(
            '[BUY] recovered:',
            errorMessage(
              error,
            ),
          )
        }

        await pause(
          15_000,
          50_000,
        )
      }

      if (
        paused ||
        stopping
      ) {
        continue
      }

      markRunner(
        'managing',
      )

      try {
        await managePosition(
          stats,
        )
      } catch (error) {
        console.error(
          '[MANAGE] recovered:',
          errorMessage(
            error,
          ),
        )
      }

      stats.cycles++

      stats.updatedAt =
        new Date().toISOString()

      await writeFile(
        statsPath,

        `${JSON.stringify(
          stats,
          null,
          2,
        )}\n`,
      )

      consecutiveRunnerErrors =
        0

      lastRunnerError =
        undefined

      if (
        config.maxCycles >
          0 &&
        stats.cycles >=
          config.maxCycles
      ) {
        break
      }

      markRunner(
        'sleeping',
      )

      await pause(
        60_000,
        60_000,
      )
    } catch (error) {
      consecutiveRunnerErrors++

      lastRunnerError =
        errorMessage(
          error,
        )

      const backoffMs =
        Math.min(
          consecutiveRunnerErrors *
            30_000,

          5 * 60_000,
        )

      markRunner(
        'backoff',
      )

      console.error(
        `[RECOVERY] Trading cycle failed but runner is still alive.\n${lastRunnerError}\nRetrying in ${backoffMs / 1000}s.`,
      )

      void telegramNotify(
        `[RECOVERY] Trading cycle failed but runner is still alive.\n${lastRunnerError}\nRetrying in ${backoffMs / 1000}s.`,
      )

      await sleep(
        backoffMs,
      )
    }
  }

  runnerAlive = false

  markRunner(
    'stopped',
  )
}

process.on(
  'SIGINT',
  () => {
    stopping = true
  },
)

process.on(
  'SIGTERM',
  () => {
    stopping = true
  },
)

const servicePort =
  Number(
    process.env.PORT ||
      3001,
  )

createServer(
  (
    request,
    response,
  ) => {
    if (
      request.url ===
        '/health' ||
      request.url ===
        '/status'
    ) {
      response.writeHead(
        200,
        {
          'content-type':
            'application/json',

          'cache-control':
            'no-store',
        },
      )

      response.end(
        JSON.stringify({
          ok: true,

          runnerAlive,

          runnerStage,

          paused,

          stopping,

          lastRunnerActivityAt,

          lastRunnerError,

          maintenanceBusy,

          creatorTokens:
            createdTokens.length,

          stats:
            activeStats,
        }),
      )

      return
    }

    response.writeHead(
      200,
      {
        'content-type':
          'text/plain',
      },
    )

    response.end(
      'Flipt bot is running. Use Telegram /status for details.\n',
    )
  },
).listen(
  servicePort,
  () =>
    console.log(
      `Health service: http://localhost:${servicePort}/health`,
    ),
)

void registerTelegramCommands()

void startTelegramPolling()

/*
  This is deliberately separate from main().

  Therefore even if CREATE is repeatedly reverting and the
  trading loop enters recovery/backoff, the creator fee /
  bond / unbond worker continues running every minute.
*/

void maintenanceLoop()

main().catch(
  (
    error: unknown,
  ) => {
    runnerAlive = false

    markRunner(
      'stopped',
    )

    lastRunnerError =
      errorMessage(
        error,
      )

    console.error(
      '[RUNNER] fatal error:',
      error,
    )

    void telegramNotify(
      `Runner stopped unexpectedly: ${lastRunnerError}`,
    )
  },
)

void walletClient
