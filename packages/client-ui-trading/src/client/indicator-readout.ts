/**
 * 主图指标读数行（图表页签顶部、图表容器上方）的渲染项计算（纯函数，vitest 直测）。
 *
 * 布局契约（2026-09-15 bug 修复）：读数行是 flex 流内元素（`flex: none`），它的
 * **行数直接决定下方图表容器的高度**——lightweight-charts 随容器尺寸重排+重定标，
 * 于是读数行行数一变，整张图（蜡烛、主图指标线、价格轴）就跳一次并重绘一帧。
 * 因此每项的「有无」与「宽度」都必须与十字光标位置无关：
 *
 * - **恒定产出**：每个 output 恒产出 1 项；无值（如 KDAS 关键日锚点之前的
 *   `undefined`）渲染 '—' 占位，不再整项消失。旧实现跳过无值项，悬停跨过
 *   锚点时项数 6→5→4 变化，行数 2→1 跳动（牧原股份 6 条 KDAS 实测：图表高度
 *   1235.6→1212.4px、同一价位 y 360.5→354.1px）。
 * - **值列定宽**：宽度取该 output 全序列格式化后的最大字符数（ch），值/占位同宽，
 *   于是同一标的、同一指标集下行内每项宽度只随数据量级变化，不随悬停变化。
 *
 * 行内每项的宽度还取决于 title/label（固定字符串）与值列宽度，两者都与
 * readoutIndex 无关，故整行换行位置（行数）与悬停无关。
 */
import type { IndicatorOutput } from '@dshtrading/indicators'

/** 缺值占位（与 fmtPrice/fmtChange/fmtPercent 的 '—' 约定一致）。 */
const MISSING = '—'

/** 参与读数行的指标组（QuoteStage 的 TvIndicatorGroup 子集，结构化兼容）。 */
export interface IndicatorReadoutGroup {
  /** 实例 key（indicators.instanceKey）。 */
  key: string
  /** 指标显示名（definition.title）。 */
  title: string
  outputs: readonly IndicatorOutput[]
}

export interface ReadoutItem {
  /** React list key：`${group.key}.${output.key}`。 */
  key: string
  /** 指标显示名（已去掉末尾参数括号）。 */
  title: string
  /** 图例小样：画出来的线（颜色同 color）；只显示读数、不画线的（如评分）为 null。 */
  swatch: { style: 'solid' | 'dotted' | 'circles'; width: number } | null
  /** 是否在这项前面写指标名：只在每组第一项、且读数行里不止一组时写（一组时名字是噪音）。 */
  showTitle: boolean
  /** 分量名（output.key，如 KDAS_26-09-05）。 */
  label: string
  /** 读数文本；该根无值 = '—'。 */
  text: string
  /** 分量颜色（output.color）。 */
  color: string
  /** 值列最小宽度（ch）= 全序列格式化后的最大字符数。 */
  width: number
}

/** 值列最小宽度：该 output 全序列里最长的格式化读数（与当前下标无关）。 */
function valueColumnWidth(output: IndicatorOutput): number {
  const precision = output.precision ?? 2
  let width = MISSING.length
  for (const value of output.values) {
    if (value === undefined || !Number.isFinite(value)) continue
    const length = value.toFixed(precision).length
    if (length > width) width = length
  }
  return width
}

/** 指标名去掉末尾的参数括号：「Z单针(3,21)」→「Z单针」；参数在指标面板里看。 */
export function shortTitle(title: string): string {
  return title.replace(/\s*[(\uFF08][^()\uFF08\uFF09]*[)\uFF09]\s*$/, '') || title
}

const constantCache = new WeakMap<readonly (number | undefined)[], boolean>()

/**
 * 整段都是同一个数的分量（如 Z单针 的 85 / 30 参考线）：读数恒定，写进读数行只是噪音。
 * 至少两个有效值且全部相等才算；按 values 数组缓存。
 */
export function isConstantOutput(output: Pick<IndicatorOutput, 'values'>): boolean {
  const cached = constantCache.get(output.values)
  if (cached !== undefined) return cached
  let first: number | undefined
  let count = 0
  let constant = true
  for (const value of output.values) {
    if (value === undefined || !Number.isFinite(value)) continue
    count += 1
    if (first === undefined) first = value
    else if (value !== first) { constant = false; break }
  }
  const result = constant && count >= 2
  constantCache.set(output.values, result)
  return result
}

/**
 * 读数项：readoutIndex 为空（序列未就绪）时整行为空；否则按组、按 output 顺序
 * 恒定产出等量项目——无值项以 '—' 占位。组序与 output 序即渲染顺序。
 */
export function readoutItems(groups: readonly IndicatorReadoutGroup[], readoutIndex: number | null): ReadoutItem[] {
  if (readoutIndex === null) return []
  const items: ReadoutItem[] = []
  const shown = (output: IndicatorOutput): boolean => output.noLegend !== true && !isConstantOutput(output)
  const multipleGroups = groups.filter(group => group.outputs.some(shown)).length > 1
  for (const group of groups) {
    let first = true
    for (const output of group.outputs) {
      if (!shown(output)) continue
      const value = output.values[readoutIndex]
      const precision = output.precision ?? 2
      items.push({
        key: `${group.key}.${output.key}`,
        title: shortTitle(group.title),
        showTitle: multipleGroups && first,
        swatch: output.noDraw === true || output.kind !== 'line' ? null : { style: output.lineStyle ?? 'solid', width: output.lineWidth ?? 1 },
        label: output.key,
        text: value === undefined || !Number.isFinite(value) ? MISSING : value.toFixed(precision),
        color: output.color,
        width: valueColumnWidth(output),
      })
      first = false
    }
  }
  return items
}
