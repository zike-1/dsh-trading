/** 历史流通股本对齐到 K 线。 */
import { describe, expect, it } from 'vitest'
import { barFloatShares } from '../src/client/float-history.ts'

const day = (year: number, month: number, date: number): { openTime: number } => ({ openTime: Date.UTC(year, month - 1, date) })
const events = [
  { date: 20240110, before: 100, after: 200 },
  { date: 20240601, before: 200, after: 300 },
]

describe('barFloatShares', () => {
  it('用户看到的历史换手率用当时的流通股本，变动当天就生效', () => {
    // Given 两次变动
    const bars = [day(2024, 1, 9), day(2024, 1, 10), day(2024, 5, 31), day(2024, 6, 1), day(2026, 1, 1)]
    // When 对齐
    // Then 第一次之前用变动前，其后取不晚于当天的最后一次，单位换算成股
    expect(barFloatShares(bars, events)).toEqual([1_000_000, 2_000_000, 2_000_000, 3_000_000, 3_000_000])
  })

  it('用户切到没有股本记录的股票时全部留空，交给最新流通股本', () => {
    // Given 没有记录
    // When 对齐
    // Then 全是 undefined，长度不变
    expect(barFloatShares([day(2024, 1, 9), day(2024, 1, 10)], [])).toEqual([undefined, undefined])
  })

  it('用户不会因为记录里的零值拿到 0 股', () => {
    // Given 变动后是 0 的脏记录、变动前是 0 的首条记录
    const bad = [{ date: 20240110, before: 0, after: 0 }]
    const firstZero = [{ date: 20240110, before: 0, after: 500 }]
    // When 对齐
    // Then 脏记录留空；首条变动前是 0 时用变动后
    expect(barFloatShares([day(2024, 1, 10)], bad)).toEqual([undefined])
    expect(barFloatShares([day(2024, 1, 9)], firstZero)).toEqual([5_000_000])
  })
})
