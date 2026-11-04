/** 调度把标的和流通股本交给 compute；noLegend 的输出不进读数行。 */
import { describe, expect, it } from 'vitest'
import type { IndicatorComputeContext, IndicatorDefinition } from '@dshtrading/indicators'
import { dispatchIndicatorGroups } from '../src/client/indicator-dispatch.ts'
import { readoutItems } from '../src/client/indicator-readout.ts'

describe('compute 的标的信息', () => {
  it('用户切到某只股票时指标拿得到代码和流通股本', () => {
    // Given 一个记录 context 的指标
    let seen: IndicatorComputeContext | undefined
    const definition: IndicatorDefinition = {
      id: 'probe',
      pane: 'sub',
      title: 'probe',
      params: [],
      compute: (_bars, _params, context) => { seen = context; return [] },
    }
    // When 调度
    dispatchIndicatorGroups({
      klines: [],
      instances: [{ id: 'probe', params: {} }],
      market: 'cn',
      symbol: '000860.SZ',
      aux: {},
      floatShares: 741760000,
      deps: { getDefinition: () => definition, clampParams: (_d, params) => params, instanceKey: () => 'probe:' },
    })
    // Then 三项都到位
    expect(seen).toEqual({ market: 'cn', symbol: '000860.SZ', floatShares: 741760000, barFloatShares: undefined })
  })
})

describe('读数行', () => {
  it('用户在读数行看不到 noLegend 的序列', () => {
    // Given 一条普通线和一条 noLegend 的线
    const group = {
      key: 'g',
      title: 'g',
      outputs: [
        { key: '砖位', kind: 'line' as const, color: '#f00', noLegend: true, values: [1] },
        { key: 'J', kind: 'line' as const, color: '#f0f', values: [2] },
      ],
    }
    // When 产出读数项
    // Then 只有 J
    expect(readoutItems([group], 0).map(item => item.label)).toEqual(['J'])
  })
})
