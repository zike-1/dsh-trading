/**
 * 自定义指标的矩形段（通达信 STICKLINE）和文字标注（DRAWTEXT/DRAWICON）：Series Primitive。
 *
 * 库的 HistogramSeries 柱恒从零基线起画，画不了两端都非零的矩形，所以这里按当前坐标轴
 * 每帧换算坐标，缩放、平移、调整 pane 高度都自动跟随。条件、端点和颜色全部由指标算好放进
 * `output.sticks` / `output.labels`，本模块不懂任何战法，只按数组顺序画（后画盖先画）。
 */
import type {
  AutoscaleInfo, IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi,
  ISeriesPrimitive, Logical, PrimitivePaneViewZOrder, SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts'
import type { IndicatorLabel, IndicatorStick } from '@dshtrading/indicators'

/** 一段矩形的像素位置（已换算到 pane 坐标）。 */
export interface StickRect {
  left: number
  top: number
  width: number
  height: number
}

/** 占满 K 线间距时的比例，留一点缝让相邻砖块能分开。 */
const FULL_WIDTH_RATIO = 0.84
const MIN_FULL_WIDTH = 1.5
const MAX_FULL_WIDTH = 24
const THIN_WIDTH_RATIO = 0.16
const MIN_THIN_WIDTH = 1

const LABEL_FONT_SIZE = 11
const LABEL_LINE_HEIGHT = 12
/** K 线间距小于这个值时文字必然糊成一片，不画。 */
const MIN_LABEL_BAR_SPACING = 4
/** 贴着 K 线画时，文字离最低价 / 最高价的像素距离。 */
const LABEL_GAP = 4

/** 一根 K 线的最低、最高价（主图标注贴 K 线用）。 */
export interface LabelAnchor {
  low: number
  high: number
}

/** 标注的摆放：below / above 贴着 K 线最低 / 最高价按像素往下 / 往上排；free 照原价位画。 */
export interface LabelPlacement {
  side: 'below' | 'above' | 'free'
  /** 同一根同一侧的第几个（离 K 线近的在前）。 */
  order: number
}

/**
 * 主图标注贴着 K 线摆放（2026-11-04）。通达信公式习惯写 DRAWTEXT(条件, L*0.975, …)，按价格百分比
 * 留空；通达信纵轴宽看着贴近，这里日线纵轴只覆盖十来个百分点，2.5% 就是五分之一个图高，文字离
 * K 线很远。所以：价位低于这根最低价的贴到最低价下方，高于最高价的贴到最高价上方，同一根同一侧
 * 按原价位离 K 线的远近依次排开；落在 K 线范围内的、或没有 K 线（副图）的照原价位画。
 */
export function labelPlacements(
  labels: readonly Pick<IndicatorLabel, 'index' | 'price'>[],
  anchor?: (index: number) => LabelAnchor | undefined,
): LabelPlacement[] {
  const sides = labels.map((label) => {
    const bar = anchor?.(label.index)
    if (bar === undefined || !Number.isFinite(label.price)) return { side: 'free' as const, distance: 0 }
    if (label.price < bar.low) return { side: 'below' as const, distance: bar.low - label.price }
    if (label.price > bar.high) return { side: 'above' as const, distance: label.price - bar.high }
    return { side: 'free' as const, distance: 0 }
  })
  const groups = new Map<string, number[]>()
  sides.forEach((entry, i) => {
    if (entry.side === 'free') return
    const key = `${labels[i]!.index}:${entry.side}`
    groups.set(key, [...(groups.get(key) ?? []), i])
  })
  const order = new Array<number>(labels.length).fill(0)
  for (const members of groups.values()) {
    members.sort((a, b) => sides[a]!.distance - sides[b]!.distance || a - b)
    members.forEach((member, rank) => { order[member] = rank })
  }
  return sides.map((entry, i) => ({ side: entry.side, order: order[i]! }))
}

/**
 * 同一根同一价位有多个标注时依次错开，否则文字叠在一起读不出来（通达信是直接叠的）。
 * 返回与 labels 对齐的纵向像素偏移。
 */
export function labelOffsets(labels: readonly Pick<IndicatorLabel, 'index' | 'price' | 'stackUp'>[]): number[] {
  const seen = new Map<string, number>()
  return labels.map((label) => {
    const key = `${label.index}:${label.price}`
    const order = seen.get(key) ?? 0
    seen.set(key, order + 1)
    const offset = order * LABEL_LINE_HEIGHT
    return label.stackUp === true && offset > 0 ? -offset : offset
  })
}

/** STICKLINE 宽度参数 → 像素宽度：>= 1 占满间距，< 1 是细棒。 */
export function stickPixelWidth(width: number, barSpacing: number | null): number {
  const spacing = barSpacing === null || !Number.isFinite(barSpacing) ? 8 : Math.abs(barSpacing)
  if (width < 1) return Math.max(MIN_THIN_WIDTH, spacing * THIN_WIDTH_RATIO)
  return Math.max(MIN_FULL_WIDTH, Math.min(MAX_FULL_WIDTH, spacing * FULL_WIDTH_RATIO))
}

/** 两端数值 → 像素矩形。两端重合或坐标不可用时返回 null（不画）。 */
export function stickRect(
  stick: Pick<IndicatorStick, 'from' | 'to' | 'width'>,
  centerX: number,
  toCoordinate: (value: number) => number | null,
  barSpacing: number | null,
): StickRect | null {
  if (!Number.isFinite(centerX)) return null
  const yFrom = toCoordinate(stick.from)
  const yTo = toCoordinate(stick.to)
  if (yFrom === null || yTo === null || !Number.isFinite(yFrom) || !Number.isFinite(yTo)) return null
  const height = Math.abs(yFrom - yTo)
  if (height <= 0) return null
  const width = stickPixelWidth(stick.width, barSpacing)
  return { left: centerX - width / 2, top: Math.min(yFrom, yTo), width, height }
}

/** 相邻两根 K 线的像素间距；缩放时库自己重算坐标，这里不缓存。 */
export function stickBarSpacing(logicalCoordinate: (index: number) => number | null, index: number): number | null {
  const here = logicalCoordinate(index)
  if (here === null || !Number.isFinite(here)) return null
  const previous = logicalCoordinate(index - 1)
  if (previous !== null && Number.isFinite(previous)) return Math.abs(here - previous)
  const next = logicalCoordinate(index + 1)
  if (next !== null && Number.isFinite(next)) return Math.abs(next - here)
  return null
}

/** 可见下标范围内矩形端点的数值范围，供纵轴缩放；范围内没有矩形时返回 null。 */
export function sticksValueRange(
  sticks: readonly IndicatorStick[],
  fromIndex: number,
  toIndex: number,
): { minValue: number; maxValue: number } | null {
  let minValue = Infinity
  let maxValue = -Infinity
  for (const stick of sticks) {
    if (stick.index < fromIndex || stick.index > toIndex) continue
    minValue = Math.min(minValue, stick.from, stick.to)
    maxValue = Math.max(maxValue, stick.from, stick.to)
  }
  return minValue === Infinity ? null : { minValue, maxValue }
}

export class StickLinePrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | undefined
  private series: ISeriesApi<SeriesType, Time> | undefined
  private readonly sticks: readonly IndicatorStick[]
  private readonly views: readonly IPrimitivePaneView[]

  constructor(
    sticks: readonly IndicatorStick[],
    dark: boolean,
    labels: readonly IndicatorLabel[] = [],
    /** 主图传入：按下标给 K 线最低 / 最高价，标注贴着 K 线画；副图不传。 */
    anchor?: (index: number) => LabelAnchor | undefined,
  ) {
    this.sticks = sticks
    const offsets = labelOffsets(labels)
    const placements = labelPlacements(labels, anchor)
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        const chart = this.chart
        const series = this.series
        if (chart === undefined || series === undefined) return
        const timeScale = chart.timeScale()
        const toCoordinate = (value: number): number | null => series.priceToCoordinate(value) as number | null
        const logicalCoordinate = (index: number): number | null => timeScale.logicalToCoordinate(index as Logical) as number | null
        const range = timeScale.getVisibleLogicalRange()
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          context.save()
          for (const stick of this.sticks) {
            if (range !== null && (stick.index < range.from - 1 || stick.index > range.to + 1)) continue
            const center = logicalCoordinate(stick.index)
            if (center === null) continue
            const rect = stickRect(stick, center, toCoordinate, stickBarSpacing(logicalCoordinate, stick.index))
            if (rect === null || rect.left + rect.width < -2 || rect.left > mediaSize.width + 2) continue
            const color = dark ? stick.color : stick.lightColor ?? stick.color
            if (stick.hollow === true) {
              context.strokeStyle = color
              context.lineWidth = 1
              context.strokeRect(Math.round(rect.left) + 0.5, Math.round(rect.top) + 0.5, Math.max(1, Math.round(rect.width) - 1), Math.max(1, Math.round(rect.height) - 1))
              continue
            }
            context.fillStyle = color
            context.fillRect(rect.left, rect.top, rect.width, rect.height)
          }
          context.font = `${LABEL_FONT_SIZE}px sans-serif`
          context.textAlign = 'center'
          context.textBaseline = 'middle'
          labels.forEach((label, order) => {
            if (range !== null && (label.index < range.from - 1 || label.index > range.to + 1)) return
            const center = logicalCoordinate(label.index)
            if (center === null) return
            const spacing = stickBarSpacing(logicalCoordinate, label.index)
            if (spacing !== null && spacing < MIN_LABEL_BAR_SPACING) return
            const placement = placements[order]
            const bar = placement !== undefined && placement.side !== 'free' ? anchor?.(label.index) : undefined
            let y: number | null
            if (placement !== undefined && bar !== undefined && placement.side === 'below') {
              const edge = toCoordinate(bar.low)
              y = edge === null ? null : edge + LABEL_GAP + LABEL_LINE_HEIGHT / 2 + placement.order * LABEL_LINE_HEIGHT
            } else if (placement !== undefined && bar !== undefined && placement.side === 'above') {
              const edge = toCoordinate(bar.high)
              y = edge === null ? null : edge - LABEL_GAP - LABEL_LINE_HEIGHT / 2 - placement.order * LABEL_LINE_HEIGHT
            } else {
              const at = toCoordinate(label.price)
              y = at === null ? null : at + (offsets[order] ?? 0)
            }
            if (y === null) return
            context.fillStyle = dark ? label.color : label.lightColor ?? label.color
            context.fillText(label.text, center, y)
          })
          context.restore()
        })
      },
    }
    const paneView: IPrimitivePaneView = {
      // 方法而非属性：库按 paneView.zOrder?.() 调用。
      zOrder: (): PrimitivePaneViewZOrder => 'normal',
      renderer: () => renderer,
    }
    this.views = [paneView]
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart
    this.series = param.series
  }

  detached(): void {
    this.chart = undefined
    this.series = undefined
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views
  }

  /** STICKLINE 也撑坐标轴：贴底的买入细棒（-18）不在任何序列的数值范围里。 */
  autoscaleInfo(startTimePoint: Logical, endTimePoint: Logical): AutoscaleInfo | null {
    const priceRange = sticksValueRange(this.sticks, startTimePoint, endTimePoint)
    return priceRange === null ? null : { priceRange }
  }
}
