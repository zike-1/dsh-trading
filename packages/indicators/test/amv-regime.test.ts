import { describe, expect, it } from 'vitest'
import { computeAmvRegimes } from '../src/amv-regime.ts'
import { presetDefinitions } from '../src/presets.ts'

const rows = (closes: number[]) => closes.map((close, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, close }))

describe('活跃市值区间', () => {
  it('用户看到 +4% 当日转多，阈值以下不提前触发', () => {
    // Given 初始未知且单日恰好 +4%
    const input = rows([100, 104])
    // When 逐日计算
    const result = computeAmvRegimes(input)
    // Then 起始未知，当日转多
    expect(result.points.map(p => p.state)).toEqual([null, 'bull'])
    expect(computeAmvRegimes(rows([100, 103.999])).points[1]?.state).toBeNull()
  })
  it('用户看到两日算术合计 +4% 转多，不把复利超过阈值当作合计超过阈值', () => {
    // Given 两个 +2% 与两个 +1.99%
    const exact = rows([100, 102, 104.04])
    // When 比较算术合计
    const result = computeAmvRegimes(exact)
    // Then 第二日才转多；复利 +4.019601% 的后者仍未知
    expect(result.points.map(p => p.state)).toEqual([null, null, 'bull'])
    expect(computeAmvRegimes(rows([100, 101.99, 104.019601])).points[2]?.state).toBeNull()
  })
  it('用户看到 -2.3% 当日转空，同时满足两日转多时仍以空头优先', () => {
    // Given 首日大涨后当日回撤恰好 -2.3%，两日合计仍超过 +4%
    const input = rows([100, 110, 107.47])
    // When 逐日计算
    const result = computeAmvRegimes(input)
    // Then 当日空头优先，未到阈值的独立样本不触发
    expect(result.points.map(p => p.state)).toEqual([null, 'bull', 'bear'])
    expect(computeAmvRegimes(rows([100, 97.701])).points[1]?.state).toBeNull()
  })
  it('用户在无新信号时看到状态延续，区间结束在最后一条真实数据', () => {
    // Given 转多后横盘
    const input = rows([100, 104, 104, 104])
    // When 汇总区间
    const result = computeAmvRegimes(input)
    // Then 只有一个区间，无未来日期
    expect(result.intervals).toEqual([{ start: '2026-09-02', end: '2026-09-04', state: 'bull' }])
    expect(result.points).toHaveLength(4)
  })
  it('用户遇到交易日缺记录时看到留白，缺口后的横盘不继承旧状态', () => {
    // Given 日历有 3 日，但源数据缺 3 日
    const input = [...rows([100, 104]), { date: '2026-09-04', close: 104 }]
    // When 与独立交易日历核查
    const result = computeAmvRegimes(input, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'])
    // Then 缺日可追溯，缺口后等待新信号
    expect(result.missingDates).toEqual(['2026-09-03'])
    expect(result.points.map(p => p.state)).toEqual([null, 'bull', null])
    expect(result.intervals[0]?.end).toBe('2026-09-02')
  })
  it('用户遇到非法收盘值时不会得到延续或两日伪信号', () => {
    // Given 已转多后缺失数值，再次出现同价
    const input = rows([100, 104, Number.NaN, 104, 104])
    // When 计算
    const result = computeAmvRegimes(input)
    // Then 非法值及其后无信号的日期未知
    expect(result.points.map(p => p.state)).toEqual([null, 'bull', null, null, null])
  })
  it('用户逐日回放时历史状态与完整序列前缀一致，不受未来行情影响', () => {
    // Given 多次切换的完整历史
    const input = rows([100, 104, 101, 100, 103, 105, 110, 90])
    const full = computeAmvRegimes(input)
    // When 每个时间点只提供当时已经产生的行情
    for (let end = 1; end <= input.length; end++) {
      const prefix = computeAmvRegimes(input.slice(0, end))
      // Then 每个已知状态一致
      expect(prefix.points).toEqual(full.points.slice(0, end))
    }
  })
  it('用户在技术指标中选择原生主图开关，默认只应用 A 股日 K', () => {
    // Given 真实预置注册表
    const definition = presetDefinitions().find(item => item.id === 'amv-regime')!
    // When 查看注册契约
    const output = definition.compute([], {})
    // Then 不产生价格线，也不默认强制开启
    expect(definition.title).toBe('活跃市值多空区间')
    expect(definition.pane).toBe('main')
    expect(definition.markets).toEqual(['cn'])
    expect(definition.defaultApplyScope).toEqual({ cn: { enabled: true, intervals: ['1d'] } })
    expect(definition.defaultActive).toBeUndefined()
    expect(output).toEqual([])
  })
})
