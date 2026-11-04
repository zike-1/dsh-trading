/** 历史流通股本 → 与 K 线逐根对齐的流通股本（纯函数）。 */
import type { Kline } from './types.ts'

/** 一次流通股本变动，单位万股。date 形如 20261102。 */
export interface FloatShareEvent {
  date: number
  before: number
  after: number
}

const SHANGHAI_OFFSET_MS = 8 * 3_600_000

/** K 线所属交易日（上海时间），形如 20261102。 */
function barDate(bar: Pick<Kline, 'openTime'>): number {
  const day = new Date(bar.openTime + SHANGHAI_OFFSET_MS)
  return day.getUTCFullYear() * 10000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate()
}

/**
 * 每根 K 线当时的流通股本（股）。取不晚于当天的最后一次变动，第一次变动之前用变动前的
 * 流通盘；算不出正数的根留 undefined，指标回落到最新流通股本。
 */
export function barFloatShares(
  klines: readonly Pick<Kline, 'openTime'>[],
  events: readonly FloatShareEvent[],
): Array<number | undefined> {
  const first = events[0]
  if (first === undefined) return klines.map(() => undefined)
  const initial = first.before > 0 ? first.before : first.after
  return klines.map((bar) => {
    const date = barDate(bar)
    let low = 0
    let high = events.length - 1
    let hit = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (events[mid]!.date <= date) {
        hit = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    const shares = hit < 0 ? initial : events[hit]!.after
    return shares > 0 ? shares * 10000 : undefined
  })
}
