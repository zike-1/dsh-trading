import { readFile, stat } from 'node:fs/promises'
import { computeAmvRegimes } from '@dshtrading/indicators'
import type { AmvHistory, AmvRow } from '@dshtrading/indicators'
import { amvCalendarFile, amvFile } from './local-data-config.ts'

export interface AmvOhlcRow extends AmvRow { open: number; high: number; low: number; volume: number; amount: number }
const SYMBOL = Buffer.from('Z_SK0AMV\0')

export function amvDate(value: number): string {
  const text = String(value)
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  if (text.length !== 8 || !Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== iso) throw new Error(`Invalid 0AMV date: ${value}`)
  return iso
}

/** 本机 VDAT 样本验证的格式：符号索引 + 250×28 字节分页，非通达信 DAY。 */
export function decodeAmvVdat(raw: Buffer): AmvOhlcRow[] {
  if (raw.length < 24 || raw.readUInt16LE(20) !== 28) throw new Error('Unsupported 0AMV VDAT record layout')
  const hits: number[] = []
  for (let offset = raw.indexOf(SYMBOL); offset >= 0; offset = raw.indexOf(SYMBOL, offset + SYMBOL.length)) hits.push(offset)
  if (hits.length < 3) throw new Error('Z_SK0AMV index/data not found')
  const index = hits[1]!
  const latest = amvDate(raw.readUInt32LE(index + 32))
  const rows: AmvOhlcRow[] = []
  for (let block = 0; block < hits.length - 2; block++) {
    const entry = index + 36 + block * 9
    const position = hits[block + 2]!
    if (entry + 9 > hits[2]! || raw.readUInt32LE(entry) !== block + 1) throw new Error('Invalid 0AMV block index')
    const count = raw[entry + 4]!
    if (count < 1 || count > 250 || position + 32 + 250 * 28 + 16 > raw.length) throw new Error('Truncated 0AMV block')
    if (block < hits.length - 3 && hits[block + 3]! - position !== 7048) throw new Error('Unsupported 0AMV page layout')
    for (let slot = 0; slot < count; slot++) {
      const offset = position + 32 + slot * 28
      const date = amvDate(raw.readUInt32LE(offset))
      const values = Array.from({ length: 6 }, (_, i) => raw.readFloatLE(offset + 4 + i * 4))
      const [open, high, low, close, volume, amount] = values as [number, number, number, number, number, number]
      if (!values.every(Number.isFinite) || Math.min(open, high, low, close) <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close) || volume < 0 || amount < 0) throw new Error(`Invalid 0AMV OHLC: ${date}`)
      if (rows.length > 0 && date <= rows[rows.length - 1]!.date) throw new Error(`Duplicate/out-of-order 0AMV date: ${date}`)
      rows.push({ date, open, high, low, close, volume, amount })
    }
    if (rows[rows.length - 1]!.date !== amvDate(raw.readUInt32LE(entry + 5))) throw new Error('0AMV page end disagrees with index')
  }
  if (rows[rows.length - 1]?.date !== latest) throw new Error('0AMV latest date disagrees with index')
  return rows
}

/** 仅用本地上证指数 DAY 的日期作为近期独立交易日历，不取其行情计算多空。 */
export function decodeAmvCalendar(raw: Buffer): string[] {
  if (raw.length === 0 || raw.length % 32 !== 0) throw new Error('Invalid local trading calendar')
  const dates: string[] = []
  for (let offset = 0; offset < raw.length; offset += 32) {
    const date = amvDate(raw.readUInt32LE(offset))
    if (dates.length > 0 && date <= dates[dates.length - 1]!) throw new Error('Invalid calendar order')
    dates.push(date)
  }
  return dates
}

/** 不接受请求参数中的文件路径；失败关闭，不回退网络行情或旧快照。 */
export async function readLocalAmv(): Promise<AmvHistory> {
  const sourceFile = amvFile() ?? ''
  const calendarFile = amvCalendarFile() ?? ''
  try {
    if (!sourceFile || !calendarFile) throw new Error('local A-share data is not configured: set zhinanzhenDataDir and tdxDir in local-data.json')
    const before = await stat(sourceFile)
    const raw = await readFile(sourceFile)
    const after = await stat(sourceFile)
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('0AMV file is being updated; retry after update completes')
    const rows = decodeAmvVdat(raw)
    const calendar = decodeAmvCalendar(await readFile(calendarFile))
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
    if (rows[rows.length - 1]!.date > today) throw new Error('0AMV contains future dates')
    const result = computeAmvRegimes(rows, calendar)
    return {
      available: true, sourceFile, fileUpdatedAt: after.mtime.toISOString(),
      firstDate: rows[0]!.date, lastDate: rows[rows.length - 1]!.date,
      calendarFirstDate: calendar[0]!, calendarLastDate: calendar[calendar.length - 1]!,
      ...result,
      notice: `收盘后状态；仅 A 股日 K；有效日期外留白。独立缺日核查 ${calendar[0]}—${calendar[calendar.length - 1]}；更早交易日完整性未独立核验。缺失 ${result.missingDates.length} 日。`,
    }
  } catch (error) {
    return { available: false, sourceFile, points: [], intervals: [], missingDates: [], notice: `0AMV 本地数据不可用：${error instanceof Error ? error.message : String(error)}` }
  }
}
