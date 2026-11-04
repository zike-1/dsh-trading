import { readFile, stat } from 'node:fs/promises'
import { tdxGbbqFile } from './local-data-config.ts'
import { GBBQ_KEY_BASE64 } from './tdx-gbbq-key.ts'

/** 一次流通股本变动，单位万股。date 形如 20261102。 */
export interface FloatShareEvent {
  date: number
  before: number
  after: number
}

/** 一次除权除息：每 10 股派现、配股价、每 10 股送转、每 10 股配股。 */
export interface DividendEvent {
  date: number
  cash: number
  rightsPrice: number
  bonus: number
  rights: number
}

export type FloatHistoryWire =
  | { available: true; symbol: string; sourceFile: string; fileUpdatedAt: string; events: FloatShareEvent[] }
  | { available: false; symbol: string; sourceFile: string; events: []; notice: string }

const RECORD_SIZE = 29
/** 流通股本会变的记录：送配上市、解禁、增发等。pytdx 没有命名这些字段，读法核对见 zettaranc 技能 tdx_local_client。 */
const SHARE_CATEGORIES = new Set([2, 3, 5, 6, 7, 8, 9, 10, 11, 12])
const DIVIDEND_CATEGORY = 1
const MARKET_PREFIX: Record<number, string> = { 0: 'sz', 1: 'sh', 2: 'bj' }

const keyBytes = Buffer.from(GBBQ_KEY_BASE64, 'base64')
const key = Uint32Array.from({ length: keyBytes.length >> 2 }, (_, i) => keyBytes.readUInt32LE(i * 4))

/** 解密一条记录的前 24 字节（3 组 8 字节分组加密），后 5 字节是明文。 */
function decryptRecord(raw: Buffer, offset: number, clear: Buffer): void {
  for (let block = 0; block < 3; block++) {
    let num = (key[0x11]! ^ raw.readUInt32LE(offset + block * 8)) >>> 0
    let numOld = raw.readUInt32LE(offset + block * 8 + 4)
    for (let round = 0x10; round >= 1; round--) {
      let mixed = (key[0x112 + ((num >>> 16) & 0xff)]! + key[0x12 + (num >>> 24)]!) >>> 0
      mixed = (mixed ^ key[0x212 + ((num >>> 8) & 0xff)]!) >>> 0
      mixed = (mixed + key[0x312 + (num & 0xff)]!) >>> 0
      mixed = (mixed ^ key[round]!) >>> 0
      const previous = num
      num = (numOld ^ mixed) >>> 0
      numOld = previous
    }
    clear.writeUInt32LE((numOld ^ key[0]!) >>> 0, block * 8)
    clear.writeUInt32LE(num, block * 8 + 4)
  }
  raw.copy(clear, 24, offset + 24, offset + RECORD_SIZE)
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

/** 解出全部流通股本变动和除权除息，键形如 sh601985，每只按日期升序。 */
export function decodeGbbq(raw: Buffer): { floats: Map<string, FloatShareEvent[]>; dividends: Map<string, DividendEvent[]> } {
  if (raw.length < 4) throw new Error('gbbq file is truncated')
  const count = raw.readUInt32LE(0)
  if (raw.length !== 4 + count * RECORD_SIZE) throw new Error('Unsupported gbbq file layout')
  const floats = new Map<string, FloatShareEvent[]>()
  const dividends = new Map<string, DividendEvent[]>()
  const clear = Buffer.alloc(RECORD_SIZE)
  for (let index = 0; index < count; index++) {
    decryptRecord(raw, 4 + index * RECORD_SIZE, clear)
    const category = clear[12]!
    if (category !== DIVIDEND_CATEGORY && !SHARE_CATEGORIES.has(category)) continue
    const prefix = MARKET_PREFIX[clear[0]!]
    if (prefix === undefined) continue
    const symbol = prefix + clear.toString('latin1', 1, 7)
    const date = clear.readUInt32LE(8)
    if (category === DIVIDEND_CATEGORY) {
      pushTo(dividends, symbol, { date, cash: clear.readFloatLE(13), rightsPrice: clear.readFloatLE(17), bonus: clear.readFloatLE(21), rights: clear.readFloatLE(25) })
    } else {
      pushTo(floats, symbol, { date, before: clear.readFloatLE(13), after: clear.readFloatLE(21) })
    }
  }
  for (const events of floats.values()) events.sort((a, b) => a.date - b.date)
  for (const events of dividends.values()) events.sort((a, b) => a.date - b.date)
  return { floats, dividends }
}

export function decodeGbbqFloats(raw: Buffer): Map<string, FloatShareEvent[]> {
  return decodeGbbq(raw).floats
}

/** 600519.SH / 600519 → sh600519；认不出来返回 null。 */
export function gbbqSymbol(symbol: string): string | null {
  const match = /^(\d{6})(?:\.(SH|SZ|BJ))?$/i.exec(symbol.trim())
  if (match === null) return null
  const code = match[1]!
  if (match[2] !== undefined) return match[2].toLowerCase() + code
  if (code.startsWith('6')) return 'sh' + code
  if (code.startsWith('0') || code.startsWith('3')) return 'sz' + code
  if (code.startsWith('4') || code.startsWith('8') || code.startsWith('92')) return 'bj' + code
  return null
}

/** 全量解密要读整个文件，按文件版本缓存在内存里。 */
let cached: { version: string; floats: Map<string, FloatShareEvent[]>; dividends: Map<string, DividendEvent[]>; updatedAt: string } | undefined

/** 未配置通达信目录时抛错，调用方按「读不到」处理。 */
function gbbqFile(): string {
  const file = tdxGbbqFile()
  if (file === undefined) throw new Error('TDX directory is not configured (local-data.json tdxDir)')
  return file
}

async function loadGbbq(sourceFile: string): Promise<NonNullable<typeof cached>> {
  const before = await stat(sourceFile)
  const version = `${sourceFile}|${before.size}|${before.mtimeMs}`
  if (cached?.version !== version) {
    const raw = await readFile(sourceFile)
    const after = await stat(sourceFile)
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('gbbq file is being updated; retry after update completes')
    cached = { version, ...decodeGbbq(raw), updatedAt: after.mtime.toISOString() }
  }
  return cached
}

/** 某只股票的除权除息（键形如 sh601985）。读不到文件时返回 null，没有分红过返回空数组。 */
export async function readLocalDividends(key: string): Promise<DividendEvent[] | null> {
  try {
    return (await loadGbbq(gbbqFile())).dividends.get(key) ?? []
  } catch {
    return null
  }
}

/** 不接受请求参数中的文件路径；只读，失败关闭，由调用方决定如何退化。 */
export async function readLocalFloatHistory(symbol: string): Promise<FloatHistoryWire> {
  const sourceFile = tdxGbbqFile() ?? ''
  try {
    if (!sourceFile) throw new Error('TDX directory is not configured (local-data.json tdxDir)')
    const key = gbbqSymbol(symbol)
    if (key === null) throw new Error(`unsupported symbol: ${symbol}`)
    const loaded = await loadGbbq(sourceFile)
    return { available: true, symbol, sourceFile, fileUpdatedAt: loaded.updatedAt, events: loaded.floats.get(key) ?? [] }
  } catch (error) {
    return { available: false, symbol, sourceFile, events: [], notice: `通达信股本数据不可用：${error instanceof Error ? error.message : String(error)}` }
  }
}
