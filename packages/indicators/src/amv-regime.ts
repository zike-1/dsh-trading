/** 0AMV 收盘后的描述性市场区间；不参与任何交易决策。 */
export type AmvState = 'bull' | 'bear'
export interface AmvRow { date: string; close: number }
export interface AmvPoint { date: string; state: AmvState | null }
export interface AmvInterval { start: string; end: string; state: AmvState }
export interface AmvHistory {
  available: boolean
  sourceFile?: string
  firstDate?: string
  lastDate?: string
  fileUpdatedAt?: string
  calendarFirstDate?: string
  calendarLastDate?: string
  missingDates: string[]
  points: AmvPoint[]
  intervals: AmvInterval[]
  notice: string
}

/** calendar 是独立交易日历。缺记录/非法值后重置，等待重新形成信号。 */
export function computeAmvRegimes(rows: readonly AmvRow[], calendar: readonly string[] = []): Pick<AmvHistory, 'points' | 'intervals' | 'missingDates'> {
  const dates = new Set(rows.map(row => row.date))
  const first = rows[0]?.date ?? ''
  const last = rows[rows.length - 1]?.date ?? ''
  const missingDates = calendar.filter(date => date >= first && date <= last && !dates.has(date))
  const missing = new Set(missingDates)
  const points: AmvPoint[] = []
  const intervals: AmvInterval[] = []
  let state: AmvState | null = null
  let previous: AmvRow | undefined
  let previousReturn: number | undefined
  let calendarIndex = 0
  let active: AmvInterval | undefined
  for (const row of rows) {
    if (previous !== undefined && row.date <= previous.date) throw new Error('0AMV dates must be strictly increasing')
    let gap = false
    while (calendarIndex < calendar.length && calendar[calendarIndex]! < row.date) {
      if (missing.has(calendar[calendarIndex]!)) gap = true
      calendarIndex++
    }
    if (gap || !Number.isFinite(row.close) || row.close <= 0) {
      state = null
      previousReturn = undefined
      previous = undefined
      active = undefined
    }
    const change = previous === undefined ? undefined : row.close / previous.close - 1
    if (change !== undefined) {
      // 浮点边界容差只抵消除法误差，不四舍五入行情或改变阈值。
      if (change <= -0.023 + 1e-12) state = 'bear'
      else if (change >= 0.04 - 1e-12 || (previousReturn !== undefined && change + previousReturn >= 0.04 - 1e-12)) state = 'bull'
    }
    points.push({ date: row.date, state })
    if (state !== null) {
      if (active?.state === state) active.end = row.date
      else { active = { start: row.date, end: row.date, state }; intervals.push(active) }
    } else active = undefined
    previousReturn = change
    previous = Number.isFinite(row.close) && row.close > 0 ? row : undefined
  }
  return { points, intervals, missingDates }
}
