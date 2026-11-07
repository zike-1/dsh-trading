/**
 * 主图指标读数行渲染项单测（indicator-readout.ts）：冻结「项数与宽度不随
 * readoutIndex 变化」这条布局契约——读数行是流内元素，行数变化会让下方图表
 * 容器跳变（2026-09-15 牧原股份 6 条 KDAS 闪烁晃动 bug 的根因）。
 */
import { describe, expect, it } from 'vitest'
import { isConstantOutput, readoutItems, shortTitle } from '../src/client/indicator-readout.ts'
import type { IndicatorOutput } from '@dshtrading/indicators'

function output(key: string, values: ReadonlyArray<number | undefined>, precision?: number): IndicatorOutput {
  return { key, kind: 'line', color: '#FFD700', values, ...(precision === undefined ? {} : { precision }) }
}

const GROUP = {
  key: 'kdas',
  title: 'KDAS',
  outputs: [
    output('KDAS_24-09-24', [undefined, undefined, 42.312, 42.973], 3),
    output('KDAS_26-09-05', [undefined, undefined, undefined, 42.978], 3),
  ],
}

describe('readoutItems', () => {
  it('每个 output 恒定产出 1 项：无值项用 — 占位，不整项消失', () => {
    const beforeAnchor = readoutItems([GROUP], 1)
    expect(beforeAnchor).toHaveLength(2)
    expect(beforeAnchor.map(item => item.text)).toEqual(['—', '—'])

    const afterAnchor = readoutItems([GROUP], 3)
    expect(afterAnchor).toHaveLength(2)
    expect(afterAnchor.map(item => item.text)).toEqual(['42.973', '42.978'])
  })

  it('值列宽度取该 output 全序列最大格式化长度，与 readoutIndex 无关', () => {
    // [undefined, undefined, 42.312, 42.973] → 最长 '42.312'/'42.973' = 6ch
    const widths = [0, 1, 2, 3].map(index => readoutItems([GROUP], index).map(item => item.width))
    expect(widths).toEqual([[6, 6], [6, 6], [6, 6], [6, 6]])
  })

  it('全序列无值时值列宽度回落到占位宽度（1ch），仍恒定产出', () => {
    const empty = { key: 'x', title: 'X', outputs: [output('X1', [undefined, undefined], 3)] }
    expect(readoutItems([empty], 0)).toEqual([
      { key: 'x.X1', title: 'X', showTitle: false, swatch: { style: 'solid', width: 1 }, label: 'X1', text: '—', color: '#FFD700', width: 1 },
    ])
  })

  it('precision 缺省两位、显式三位生效', () => {
    const group = { key: 'g', title: 'G', outputs: [output('A', [1.23456]), output('B', [1.23456], 3)] }
    const items = readoutItems([group], 0)
    expect(items.map(item => item.text)).toEqual(['1.23', '1.235'])
    expect(items.map(item => item.width)).toEqual([4, 5])
  })

  it('非有限值（NaN/Infinity）按无值处理', () => {
    const group = { key: 'g', title: 'G', outputs: [output('A', [Number.NaN, Number.POSITIVE_INFINITY, 2])] }
    expect(readoutItems([group], 0)[0]?.text).toBe('—')
    expect(readoutItems([group], 1)[0]?.text).toBe('—')
    expect(readoutItems([group], 2)[0]?.text).toBe('2.00')
  })

  it('readoutIndex 为 null（序列未就绪）时整行为空', () => {
    expect(readoutItems([GROUP], null)).toEqual([])
  })

  it('多组按组序拼接，项 key / 组名 / 分量名 / 颜色透传', () => {
    const other = { key: 'ma', title: 'MA', outputs: [output('MA5', [10, 11, 12])] }
    const items = readoutItems([GROUP, other], 2)
    expect(items.map(item => item.key)).toEqual(['kdas.KDAS_24-09-24', 'kdas.KDAS_26-09-05', 'ma.MA5'])
    expect(items[0]).toMatchObject({ title: 'KDAS', label: 'KDAS_24-09-24', color: '#FFD700' })
    expect(items[2]).toMatchObject({ title: 'MA', label: 'MA5', text: '12.00' })
  })
})


describe('读数行精简（2026-11-05）', () => {
  const line = (key: string, values: Array<number | undefined>) => ({ key, kind: 'line' as const, color: '#000', values })

  it('只有一组时不写指标名，多组时每组第一项写一次（去掉参数括号）', () => {
    const one = readoutItems([{ key: 's', title: '三线合一', outputs: [line('BBI', [1, 2]), line('白线', [3, 4])] }], 1)
    expect(one.map(item => item.showTitle)).toEqual([false, false])
    const two = readoutItems([
      { key: 'ma', title: 'MA(5,10)', outputs: [line('MA5', [1, 2]), line('MA10', [1, 3])] },
      { key: 's', title: '三线合一', outputs: [line('BBI', [1, 2])] },
    ], 1)
    expect(two.map(item => [item.showTitle, item.title])).toEqual([[true, 'MA'], [false, 'MA'], [true, '三线合一']])
  })

  it('整段同一个数的参考线不进读数行', () => {
    const items = readoutItems([{ key: 'z', title: 'Z单针(3,21)', outputs: [line('短期', [10, 20]), line('85', [85, 85, 85])] }], 1)
    expect(items.map(item => item.label)).toEqual(['短期'])
    expect(isConstantOutput(line('x', [5]))).toBe(false)
    expect(shortTitle('ZXB1金砖(14,28,57,114)')).toBe('ZXB1金砖')
  })
})
