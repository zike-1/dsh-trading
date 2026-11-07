import type { AmvHistory, AmvInterval } from '@dshtrading/indicators'
import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, Logical, Time } from 'lightweight-charts'

export interface AmvBand { from: number; to: number; interval: AmvInterval }

export function isAmvChartEnabled(market: string | undefined, interval: string, instances: readonly { id: string }[]): boolean {
  return market === 'cn' && interval === '1d' && instances.some(instance => instance.id === 'amv-regime')
}

/** 精确交易日匹配：停牌柱不补、缺日不补、末日之后不延伸。 */
export function amvBandsForBars(times: readonly number[], history: AmvHistory | undefined): AmvBand[] {
  if (!history?.available) return []
  const days = new Set(history.points.filter(point => point.state !== null).map(point => point.date))
  const bands: AmvBand[] = []
  let cursor = 0
  for (let index = 0; index < times.length; index++) {
    const date = new Date(times[index]! * 1000).toISOString().slice(0, 10)
    while (cursor < history.intervals.length && history.intervals[cursor]!.end < date) cursor++
    const interval = history.intervals[cursor]
    if (!interval || date < interval.start || date > interval.end || !days.has(date)) continue
    const previous = bands[bands.length - 1]
    if (previous?.interval === interval && previous.to === index - 1) previous.to = index
    else bands.push({ from: index, to: index, interval })
  }
  return bands
}

export function amvBandRect(band: AmvBand, coordinate: (index: number) => number | null, width: number): { left: number; right: number } | null {
  // 当前库只接受整数逻辑下标；半整数会返回 0。先取相邻柱中心再推半柱边界。
  const from = coordinate(band.from)
  const to = coordinate(band.to)
  const next = coordinate(band.from + 1)
  if (from === null || to === null || next === null || ![from, to, next].every(Number.isFinite)) return null
  const halfBar = Math.abs(next - from) / 2
  const left = Math.max(0, from - halfBar)
  const right = Math.min(width, to + halfBar)
  return right > left ? { left, right } : null
}

/** 顶部多空色带的高度（像素）。 */
export const AMV_STRIP_HEIGHT = 13

/** 原生 pane primitive：由图表自身在缩放、平移、resize 后重新绘制；不参与价格轴。 */
export class AmvBackground implements ISeriesPrimitive<Time> {
  private readonly view: IPrimitivePaneView
  /** labels：多/空的显示字（由调用方按语言传入；canvas 里拿不到翻译函数）。 */
  constructor(chart: IChartApi, bands: readonly AmvBand[], dark: boolean, labels: { bull: string; bear: string } = { bull: '+', bear: '-' }) {
    const renderer: IPrimitivePaneRenderer = {
      draw: target => {
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          context.save()
          context.font = '10px sans-serif'
          for (const band of bands) {
            const rect = amvBandRect(band, index => chart.timeScale().logicalToCoordinate(index as Logical), mediaSize.width)
            if (rect === null) continue
            const bull = band.interval.state === 'bull'
            // 2026-11-05：多空主要看顶部窄色带；整段背景降到很淡，只作复盘时的区段提示，让 K 线和信号更突出
            context.fillStyle = bull ? 'rgba(230,69,69,0.055)' : 'rgba(86,190,135,0.06)'
            context.fillRect(rect.left, 0, rect.right - rect.left, mediaSize.height)
            context.fillStyle = bull ? 'rgba(230,69,69,0.32)' : 'rgba(86,190,135,0.36)'
            context.fillRect(rect.left, 0, rect.right - rect.left, AMV_STRIP_HEIGHT)
            // 只写一个多 / 空字（2026-11-05 精简）：日期范围压在 K 线顶部，和「顶」等标注挤在一起；
            // 区间颜色本身已经说明多空，太窄的区间连字也不写。
            const text = rect.right - rect.left >= 16 ? (bull ? labels.bull : labels.bear) : ''
            context.save()
            context.beginPath()
            context.rect(rect.left, 0, rect.right - rect.left, mediaSize.height)
            context.clip()
            context.fillStyle = bull ? (dark ? '#ffd0d0' : '#9b1f2b') : (dark ? '#c9f0da' : '#185c3a')
            context.textBaseline = 'middle'
            context.fillText(text, rect.left + 4, AMV_STRIP_HEIGHT / 2 + 0.5)
            context.restore()
          }
          context.restore()
        })
      },
    }
    this.view = { zOrder: () => 'bottom', renderer: () => renderer }
  }
  paneViews(): readonly IPrimitivePaneView[] { return [this.view] }
}
