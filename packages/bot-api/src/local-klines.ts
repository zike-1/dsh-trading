/**
 * A 股日线优先读本机通达信（只读），只有缺的那几天才向行情接口要。
 *
 * 为什么：页面每 30 秒重取一次 750 根日线，自选股也各取一份，全走腾讯 K 线接口，域名被 WAF
 * 拦一次图就全断。本地历史不依赖网络，接口只需要补尾巴，请求量和影响面都小得多。
 *
 * 通达信目录由 DSH_TRADING_TDX_DIR 或 DSH home 的 local-data.json（tdxDir）配置；
 * 未配置、没有目录或文件时返回 null，调用方照旧走接口。
 * 接管 A 股个股和场内 ETF（ETF 价格精度和成交量单位另有处理，见 decodeDayFile）；
 * 指数的成交量口径不同，LOF 等其它基金没核对过，都留给接口。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Kline } from '@dshtrading/api'
import { tdxDir } from './local-data-config.ts'
import { gbbqSymbol, readLocalDividends, type DividendEvent } from './local-gbbq.ts'

const RECORD_SIZE = 32
const DAY_MS = 86_400_000
const SHANGHAI_OFFSET_MS = 8 * 3_600_000
/** 集合竞价开始，此后当天才算应该有 K 线。 */
const SESSION_START_MINUTES = 9 * 60 + 15
/** 缺口超过这么多个工作日说明通达信很久没更新，不拼接，整段交给接口。 */
const MAX_TAIL_WEEKDAYS = 30
/** 尾巴和本地重叠那根的收盘价差超过这个比例，说明缺口里有除权，本地历史的复权基准已过期。 */
const OVERLAP_TOLERANCE = 0.005
const TAIL_CACHE_MS = 60_000

const STOCK_PREFIXES: Record<string, readonly string[]> = {
  sh: ['600', '601', '603', '605', '688', '689'],
  sz: ['000', '001', '002', '003', '300', '301', '302'],
  bj: ['920', '430', '83', '87', '88'],
}

/** 通达信 .day 的一根原始 K 线：价格是元，成交量是手。 */
export interface RawDayBar {
  date: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** 场内 ETF：沪市 51/56/58 开头，深市 159 开头。 */
const ETF_PREFIXES: Record<string, readonly string[]> = {
  sh: ['51', '56', '58'],
  sz: ['159'],
}

function hasPrefix(table: Record<string, readonly string[]>, key: string): boolean {
  const prefixes = table[key.slice(0, 2)] ?? []
  return prefixes.some(prefix => key.slice(2).startsWith(prefix))
}

/** sh600519 这样的代码是否 A 股个股。 */
export function isAShareStock(key: string): boolean {
  return hasPrefix(STOCK_PREFIXES, key)
}

/** sh510300 这样的代码是否场内 ETF。 */
export function isAShareEtf(key: string): boolean {
  return hasPrefix(ETF_PREFIXES, key)
}

/**
 * 解析 .day 文件：32 字节一条。个股价格放大 100 倍、成交量单位是股；ETF 价格放大 1000 倍，
 * 成交量平时是份，放量日超出 32 位上限时通达信改存手（2026-11-03 实测 588200、510300 都有）。
 * ETF 每根按「成交额 / 成交量」落在当天高低价之间来认单位，两种都对不上的记录跳过。
 */
export function decodeDayFile(raw: Buffer, kind: 'stock' | 'etf' = 'stock'): RawDayBar[] {
  if (raw.length % RECORD_SIZE !== 0) throw new Error('Unsupported .day file layout')
  const scale = kind === 'etf' ? 1000 : 100
  const bars: RawDayBar[] = []
  for (let offset = 0; offset < raw.length; offset += RECORD_SIZE) {
    const date = raw.readUInt32LE(offset)
    const open = raw.readUInt32LE(offset + 4)
    const high = raw.readUInt32LE(offset + 8)
    const low = raw.readUInt32LE(offset + 12)
    const close = raw.readUInt32LE(offset + 16)
    const valid = date >= 19900101 && date <= 21001231 && close > 0 && high >= low && high >= open && high >= close && low <= open && low <= close
    if (!valid) continue
    const rawVolume = raw.readUInt32LE(offset + 24)
    let volume = rawVolume / 100
    if (kind === 'etf' && rawVolume > 0) {
      const amount = raw.readFloatLE(offset + 20)
      const within = (price: number): boolean => price >= low / scale * 0.98 && price <= high / scale * 1.02
      if (within(amount / rawVolume)) volume = rawVolume / 100
      else if (within(amount / rawVolume / 100)) volume = rawVolume
      else continue
    }
    bars.push({ date, open: open / scale, high: high / scale, low: low / scale, close: close / scale, volume })
  }
  return bars
}

/** ETF 单日涨跌幅上限是 20%（科创/创业板 ETF），超过这个幅度只能是份额拆分或合并。 */
const ETF_SPLIT_JUMP = 0.25

/**
 * gbbq 不记 ETF 的份额拆分，比例也不能从价格倒推，所以只保留最后一次拆分之后的历史
 * （2026-11-03 实测 588200 在 2026-07-21 从 3.539 跳到 1.349，gbbq 没有对应记录）。
 */
export function sinceLastSplit(bars: readonly RawDayBar[]): RawDayBar[] {
  for (let i = bars.length - 1; i > 0; i--) {
    if (Math.abs(bars[i]!.close / bars[i - 1]!.close - 1) > ETF_SPLIT_JUMP) return bars.slice(i)
  }
  return [...bars]
}

/**
 * 通达信口径前复权：除权日之前的价格换成 (P - c) / m，c = (派现 - 配股数 × 配股价) / 10，
 * m = 1 + (送转数 + 配股数) / 10，多个事件从新到旧复合。除权日在最新 K 线之后的事件尚未生效；
 * 除权日停牌时落到其后第一根。这是通达信的口径；腾讯的前复权在有分红的股票上有微小差异
 * （2026-11-03 实测 300750 最大 0.10 元，约 0.04%），所以两边不混用同一段历史。
 */
export function forwardAdjust(bars: readonly RawDayBar[], events: readonly DividendEvent[], decimals = 2): RawDayBar[] {
  const a = bars.map(() => 1)
  const b = bars.map(() => 0)
  const last = bars[bars.length - 1]
  if (last !== undefined) {
    for (const event of [...events].sort((x, y) => y.date - x.date)) {
      if (event.date > last.date) continue
      const index = bars.findIndex(bar => bar.date >= event.date)
      if (index <= 0) continue
      const m = 1 + (event.bonus + event.rights) / 10
      const c = (event.cash - event.rights * event.rightsPrice) / 10
      if (m <= 0) continue
      for (let i = 0; i < index; i++) {
        b[i] = b[i]! - a[i]! * c / m
        a[i] = a[i]! / m
      }
    }
  }
  const unit = 10 ** decimals
  const round = (value: number): number => Math.floor(value * unit + 0.5 + 1e-9) / unit
  return bars.map((bar, i) => ({
    ...bar,
    open: round(a[i]! * bar.open + b[i]!),
    high: round(a[i]! * bar.high + b[i]!),
    low: round(a[i]! * bar.low + b[i]!),
    close: round(a[i]! * bar.close + b[i]!),
  }))
}

function dateToOpenTime(date: number): number {
  return Date.UTC(Math.floor(date / 10000), Math.floor(date / 100) % 100 - 1, date % 100)
}

export function toKlines(bars: readonly RawDayBar[]): Kline[] {
  return bars.map((bar) => {
    const openTime = dateToOpenTime(bar.date)
    return { openTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, closeTime: openTime + DAY_MS - 1 }
  })
}

/** 本地最后一根之后，到现在为止应该已经有 K 线的工作日数（不知道节假日，只排除周末）。 */
export function missingWeekdays(lastDate: number, now: number): number {
  const shanghai = new Date(now + SHANGHAI_OFFSET_MS)
  const minutes = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes()
  const today = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate())
  let missing = 0
  for (let day = dateToOpenTime(lastDate) + DAY_MS; day <= today; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    if (day === today && minutes < SESSION_START_MINUTES) continue
    missing += 1
  }
  return missing
}

/**
 * 本地历史接上接口的尾巴。尾巴必须包含本地最后一根，且收盘价对得上；对不上说明缺口里有除权，
 * 返回 null，由调用方改用接口的整段数据。尾巴里比本地新的 K 线直接追加。
 */
export function joinTail(local: readonly Kline[], tail: readonly Kline[]): Kline[] | null {
  const last = local[local.length - 1]
  if (last === undefined) return null
  const overlap = tail.find(bar => bar.openTime === last.openTime)
  if (overlap === undefined || Math.abs(overlap.close / last.close - 1) > OVERLAP_TOLERANCE) return null
  return [...local, ...tail.filter(bar => bar.openTime > last.openTime)]
}

export type TailFetcher = (symbol: string, limit: number) => Promise<Kline[]>

const tailCache = new Map<string, { at: number; lastDate: number; rows: Kline[] }>()
/**
 * 补尾巴失败的时刻。失败也缓存同样久：页面每 30 秒重取一次，接口被拦时每次都要把两个 K 线域名
 * 各等一遍超时，单次请求拖到 5 秒以上，还占着服务（2026-11-03 实测）。
 */
const tailFailedAt = new Map<string, number>()

async function cachedTail(symbol: string, lastDate: number, limit: number, fetchTail: TailFetcher, now: number): Promise<Kline[]> {
  const hit = tailCache.get(symbol)
  if (hit !== undefined && hit.lastDate === lastDate && now - hit.at < TAIL_CACHE_MS) return hit.rows
  const failedAt = tailFailedAt.get(symbol)
  if (failedAt !== undefined && now - failedAt < TAIL_CACHE_MS) throw new Error('tail fetch failed recently')
  try {
    const rows = await fetchTail(symbol, limit)
    tailFailedAt.delete(symbol)
    tailCache.set(symbol, { at: now, lastDate, rows })
    return rows
  } catch (error) {
    tailFailedAt.set(symbol, now)
    throw error
  }
}

/** 只读 .day 和 gbbq，不接受请求参数中的路径。任何一步读不到都返回 null，调用方走接口。 */
export async function readLocalBars(symbol: string): Promise<Kline[] | null> {
  const key = gbbqSymbol(symbol)
  if (key === null) return null
  const kind = isAShareStock(key) ? 'stock' : isAShareEtf(key) ? 'etf' : null
  if (kind === null) return null
  const root = tdxDir()
  if (root === undefined) return null
  try {
    const decoded = decodeDayFile(await readFile(join(root, 'vipdoc', key.slice(0, 2), 'lday', `${key}.day`)), kind)
    const bars = kind === 'etf' ? sinceLastSplit(decoded) : decoded
    const dividends = await readLocalDividends(key)
    if (bars.length === 0 || dividends === null) return null
    return toKlines(forwardAdjust(bars, dividends, kind === 'etf' ? 3 : 2))
  } catch {
    return null
  }
}

function barDate(bar: Kline): number {
  const day = new Date(bar.openTime)
  return day.getUTCFullYear() * 10000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate()
}

/**
 * 本地日线，必要时接上接口的尾巴。返回 null 表示本地接管不了（没有文件、缺口太长、缺口里有
 * 除权），调用方走接口。接口失败时返回本地已有部分，页面照常显示，当天那根由实时报价补。
 */
export async function localDailyKlines(symbol: string, limit: number | undefined, fetchTail: TailFetcher, now: number = Date.now()): Promise<Kline[] | null> {
  const local = await readLocalBars(symbol)
  if (local === null) return null
  const last = local[local.length - 1]!
  const count = limit ?? 100
  const lastDate = barDate(last)
  const missing = missingWeekdays(lastDate, now)
  if (missing === 0) return local.slice(-count)
  if (missing > MAX_TAIL_WEEKDAYS) return null
  let tail: Kline[]
  try {
    tail = await cachedTail(symbol, lastDate, missing + 2, fetchTail, now)
  } catch {
    return local.slice(-count)
  }
  const joined = joinTail(local, tail)
  return joined === null ? null : joined.slice(-count)
}
