import { describe, expect, it } from 'vitest'
import { computeAmvRegimes } from '@dshtrading/indicators'
import type { AmvHistory } from '@dshtrading/indicators'
import { amvBandsForBars, amvBandRect, isAmvChartEnabled } from '../src/client/amv-background.ts'
import { createChartStateStore } from '../src/client/chart-state.ts'
import { createIndicatorRegistry, presetDefinitions } from '@dshtrading/indicators'

const time = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000
const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']
const history: AmvHistory = { available: true, notice: '', ...computeAmvRegimes(dates.map((date, i) => ({ date, close: [100, 104, 104, 100][i]! }))) }

describe('原生 0AMV 背景', () => {
  it('用户切换周期和市场时仅 A 股日 K 启用，手工放宽适用范围也不在其他周期绘制', () => {
    // Given 已挂载的区间指标
    const instances = [{ id: 'amv-regime' }]
    // When 经过与 QuoteStage 相同的最终守卫
    const daily = isAmvChartEnabled('cn', '1d', instances)
    // Then 周月分钟及其他市场关闭；切回日 K 恢复
    expect(daily).toBe(true)
    for (const interval of ['1w', '1M', '1m', '5d']) expect(isAmvChartEnabled('cn', interval, instances)).toBe(false)
    for (const market of ['hk', 'us', 'crypto', undefined]) expect(isAmvChartEnabled(market, '1d', instances)).toBe(false)
    expect(isAmvChartEnabled('cn', '1d', [])).toBe(false)
  })
  it('用户切换股票、时间范围时按精确日期重映射，最新记录后留白', () => {
    // Given 原股票和停牌缺柱的另一股票
    const full = [...dates, '2026-09-07'].map(time)
    // When 使用同一个市场状态序列匹配不同股票
    const bands = amvBandsForBars(full, history)
    const other = amvBandsForBars(['2026-09-03', '2026-09-04', '2026-09-07'].map(time), history)
    // Then 最新日期以后的柱不在任何背景中
    expect(bands.map(b => [b.from, b.to, b.interval.state])).toEqual([[1, 2, 'bull'], [3, 3, 'bear']])
    expect(other.map(b => [b.from, b.to, b.interval.state])).toEqual([[0, 0, 'bull'], [1, 1, 'bear']])
  })
  it('用户缩放、平移时区间边界按当前图表坐标重算，不缓存旧像素', () => {
    // Given 固定逻辑区间与两种实时坐标映射
    const band = amvBandsForBars(dates.map(time), history)[0]!
    // When 缩放并平移
    const before = amvBandRect(band, i => Number.isInteger(i) ? 20 + i * 10 : 0, 200)
    const after = amvBandRect(band, i => Number.isInteger(i) ? -20 + i * 20 : 0, 200)
    // Then 两端跟随半柱边界，视窗外裁剪
    expect(before).toEqual({ left: 25, right: 45 })
    expect(after).toEqual({ left: 0, right: 30 })
    expect(amvBandRect(band, () => null, 200)).toBeNull()
  })
  it('用户关闭指标或源失效时没有背景输出，不伪造数据', () => {
    // Given 已有行情
    const bars = dates.map(time)
    // When 关闭或失效
    const closed = amvBandsForBars(bars, undefined)
    // Then 均没有渲染区间
    expect(closed).toEqual([])
    expect(amvBandsForBars(bars, { ...history, available: false })).toEqual([])
  })
  it('用户通过现有状态管理开关指标，原均线实例保持不变', () => {
    // Given 真实状态 store 和预置注册表
    const registry = createIndicatorRegistry()
    for (const definition of presetDefinitions()) registry.register(definition)
    const store = createChartStateStore(registry)
    const before = store.getSnapshot().instances.filter(instance => instance.id !== 'amv-regime')
    // When 开启再关闭
    store.togglePreset('amv-regime')
    const enabled = store.isActive('amv-regime')
    store.togglePreset('amv-regime')
    // Then 原实例不受影响
    expect(enabled).toBe(true)
    expect(store.isActive('amv-regime')).toBe(false)
    expect(store.getSnapshot().instances).toEqual(before)
  })
})
