/**
 * 矩形段 primitive：几何、绘制顺序、主题色、纵轴范围。jsdom 没有 canvas，用手写记账
 * 假体重放 draw。
 */
import { describe, expect, it } from 'vitest'
import type { IPrimitivePaneRenderer, SeriesAttachedParameter, Time } from 'lightweight-charts'
import type { IndicatorLabel, IndicatorStick } from '@dshtrading/indicators'
import { StickLinePrimitive, labelOffsets, labelPlacements, stickBarSpacing, stickPixelWidth, stickRect, sticksValueRange } from '../src/client/stick-line-primitive.ts'

const brick = (index: number, from: number, to: number, extra: Partial<IndicatorStick> = {}): IndicatorStick => ({ index, from, to, width: 3, color: '#FF3D3D', ...extra })

/** 重放一次 draw，按顺序记下每个画图调用。y = 100 - 数值，x = 下标 * 10。 */
function drawCalls(sticks: readonly IndicatorStick[], dark: boolean, range: { from: number; to: number } | null = { from: 0, to: 100 }): string[] {
  const calls: string[] = []
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    save() {},
    restore() {},
    fillRect(_x: number, y: number, _w: number, h: number) { calls.push(`fill ${this.fillStyle} ${y} ${h}`) },
    strokeRect(_x: number, y: number, _w: number, h: number) { calls.push(`stroke ${this.strokeStyle} ${y} ${h}`) },
  }
  const primitive = new StickLinePrimitive(sticks, dark)
  primitive.attached({
    chart: { timeScale: () => ({ logicalToCoordinate: (index: number) => index * 10, getVisibleLogicalRange: () => range }) },
    series: { priceToCoordinate: (value: number) => 100 - value },
  } as unknown as SeriesAttachedParameter<Time>)
  const renderer = primitive.paneViews()[0]!.renderer() as IPrimitivePaneRenderer
  renderer.draw({ useMediaCoordinateSpace: (fn: (scope: unknown) => void) => fn({ context, mediaSize: { width: 2000, height: 200 } }) } as never)
  return calls
}

describe('stickRect', () => {
  it('用户看到的砖块浮在两端之间，与零轴无关', () => {
    // Given 两端都是负数的砖
    // When 换算成像素
    const rect = stickRect(brick(1, -20, -5), 50, value => 100 - value, 10)
    // Then 上边缘取较小的 y，高度是两端差，宽度占 84% 间距
    expect(rect).toEqual({ left: 45.8, top: 105, width: 8.4, height: 15 })
  })

  it('用户不会看到零高度或坐标不可用的砖', () => {
    // Given 两端重合、坐标换算失败两种情况
    // When 换算
    // Then 都不画
    expect(stickRect(brick(1, 5, 5), 50, value => value, 10)).toBeNull()
    expect(stickRect(brick(1, 1, 5), 50, () => null, 10)).toBeNull()
  })

  it('用户缩放时宽度跟随间距并收敛，细棒明显比砖窄', () => {
    // Given 极窄、极宽的间距
    // When 算宽度
    // Then 砖宽收敛在界内，细棒至少 1 像素
    expect(stickPixelWidth(3, 0.5)).toBe(1.5)
    expect(stickPixelWidth(3, 100)).toBe(24)
    expect(stickPixelWidth(0.5, 10)).toBeCloseTo(1.6, 5)
    expect(stickPixelWidth(0.5, 1)).toBe(1)
  })

  it('用户平移到序列开头时间距取后一根', () => {
    // Given 第一根没有前一根
    // When 算间距
    // Then 用下一根
    expect(stickBarSpacing(index => (index < 0 ? null : index * 10), 0)).toBe(10)
    expect(stickBarSpacing(() => null, 0)).toBeNull()
  })
})

describe('StickLinePrimitive.draw', () => {
  it('用户看到后画的砖盖住先画的，顺序与数组一致', () => {
    // Given 同一根先空心红、再实心红、再实心黄
    const sticks = [brick(1, 0, 10, { hollow: true }), brick(1, 0, 10), brick(1, 0, 10, { color: '#FFFF00' })]
    // When 绘制
    // Then 顺序不变，空心走描边、实心走填充
    expect(drawCalls(sticks, true)).toEqual(['stroke #FF3D3D 90.5 9', 'fill #FF3D3D 90 10', 'fill #FFFF00 90 10'])
  })

  it('用户在浅色主题下看到替代色，深色主题下看到原色', () => {
    // Given 白色买入砖，浅色主题用深灰
    const sticks = [brick(1, 0, 10, { color: '#FFFFFF', lightColor: '#1F2937' })]
    // When 分别绘制
    // Then 各取各的；没有替代色的砖两种主题同色
    expect(drawCalls(sticks, true)).toEqual(['fill #FFFFFF 90 10'])
    expect(drawCalls(sticks, false)).toEqual(['fill #1F2937 90 10'])
    expect(drawCalls([brick(1, 0, 10)], false)).toEqual(['fill #FF3D3D 90 10'])
  })

  it('用户看不到视窗外的砖', () => {
    // Given 可见范围只有 10 到 20
    const sticks = [brick(1, 0, 10), brick(15, 0, 10), brick(50, 0, 10)]
    // When 绘制
    // Then 只画范围内那一根
    expect(drawCalls(sticks, true, { from: 10, to: 20 })).toHaveLength(1)
  })

  it('用户解绑后不再绘制，也不报错', () => {
    // Given 解绑后的 primitive
    const primitive = new StickLinePrimitive([brick(1, 0, 10)], true)
    primitive.detached()
    const renderer = primitive.paneViews()[0]!.renderer() as IPrimitivePaneRenderer
    // When 绘制
    // Then 直接返回，碰不到画布
    expect(() => renderer.draw({} as never)).not.toThrow()
  })
})

describe('文字标注', () => {
  /** 重放 draw，记下每段文字。y = 100 - 数值，x = 下标 * spacing。 */
  function drawLabels(labels: readonly IndicatorLabel[], dark: boolean, spacing = 10): string[] {
    const calls: string[] = []
    const context = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      font: '',
      textAlign: '',
      textBaseline: '',
      save() {},
      restore() {},
      fillRect() {},
      strokeRect() {},
      fillText(text: string, x: number, y: number) { calls.push(`${text} ${this.fillStyle} ${x} ${y}`) },
    }
    const primitive = new StickLinePrimitive([], dark, labels)
    primitive.attached({
      chart: { timeScale: () => ({ logicalToCoordinate: (index: number) => index * spacing, getVisibleLogicalRange: () => ({ from: 0, to: 100 }) }) },
      series: { priceToCoordinate: (value: number) => 100 - value },
    } as unknown as SeriesAttachedParameter<Time>)
    const renderer = primitive.paneViews()[0]!.renderer() as IPrimitivePaneRenderer
    renderer.draw({ useMediaCoordinateSpace: (fn: (scope: unknown) => void) => fn({ context, mediaSize: { width: 2000, height: 200 } }) } as never)
    return calls
  }

  it('用户在 K 线旁看到文字，颜色随主题', () => {
    // Given 一个带浅色替代色的标注
    const labels = [{ index: 2, price: 50, text: 'B1', color: '#FFFF00', lightColor: '#B58900' }]
    // When 分别绘制
    // Then 横坐标在 K 线中心，纵坐标在指定价位
    expect(drawLabels(labels, true)).toEqual(['B1 #FFFF00 20 50'])
    expect(drawLabels(labels, false)).toEqual(['B1 #B58900 20 50'])
  })

  it('用户看到同一根同一价位的多个标注错开，不叠在一起', () => {
    // Given 同价位两个向下、两个向上，另一根一个
    const labels = [
      { index: 2, price: 50, text: 'B1', color: '#f00' },
      { index: 2, price: 50, text: '针', color: '#f00' },
      { index: 2, price: 80, text: '3', color: '#f00', stackUp: true },
      { index: 2, price: 80, text: '飞', color: '#f00', stackUp: true },
      { index: 3, price: 50, text: '突', color: '#f00' },
    ]
    // When 算偏移
    // Then 只有同一根同一价位的第二个才偏移，方向按 stackUp
    expect(labelOffsets(labels)).toEqual([0, 12, 0, -12, 0])
  })

  it('用户把图缩得很小时文字不再绘制，免得糊成一片', () => {
    // Given K 线间距只有 2 像素
    // When 绘制
    // Then 不画文字
    expect(drawLabels([{ index: 2, price: 50, text: 'B1', color: '#f00' }], true, 2)).toEqual([])
  })
})

describe('纵轴范围', () => {
  it('用户看到贴底的细棒不被裁掉：范围包含可见矩形的两端', () => {
    // Given 可见范围内有一根 -18 到 -5 的细棒，范围外有一根 500
    const sticks = [brick(5, -18, -5, { width: 0.5 }), brick(6, 3, 8), brick(90, 400, 500)]
    // When 算范围
    // Then 只含可见的
    expect(sticksValueRange(sticks, 0, 10)).toEqual({ minValue: -18, maxValue: 8 })
  })

  it('用户视窗内没有矩形时不干预纵轴', () => {
    // Given 视窗外的矩形
    // When 算 autoscaleInfo
    const primitive = new StickLinePrimitive([brick(90, 1, 2)], true)
    // Then 返回 null，有矩形时给 priceRange
    expect(primitive.autoscaleInfo(0 as never, 10 as never)).toBeNull()
    expect(primitive.autoscaleInfo(0 as never, 100 as never)).toEqual({ priceRange: { minValue: 1, maxValue: 2 } })
  })
})


describe('主图标注贴着 K 线', () => {
  const bars = [{ low: 10, high: 11 }, { low: 20, high: 22 }]
  const anchor = (index: number) => bars[index]

  it('低于最低价的贴到下方、高于最高价的贴到上方，同一侧按离 K 线远近排', () => {
    const labels = [
      { index: 0, price: 9.5 },   // 下方，较近
      { index: 0, price: 9.0 },   // 下方，较远
      { index: 0, price: 11.5 },  // 上方
      { index: 1, price: 21 },    // 在 K 线范围内：照原价位
      { index: 2, price: 5 },     // 没有这根 K 线：照原价位
    ]
    expect(labelPlacements(labels, anchor)).toEqual([
      { side: 'below', order: 0 },
      { side: 'below', order: 1 },
      { side: 'above', order: 0 },
      { side: 'free', order: 0 },
      { side: 'free', order: 0 },
    ])
  })

  it('副图（不传 K 线）全部照原价位画', () => {
    expect(labelPlacements([{ index: 0, price: 1 }])).toEqual([{ side: 'free', order: 0 }])
  })
})
