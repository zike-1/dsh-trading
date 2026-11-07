/**
 * zettaranc 卡片的小部件（2026-11-04）：Z哥诊断浮层与「报告」页签共用，视觉沿用每日 HTML 报告。
 */
import type { ReactElement } from 'react'
import type { ClientZtStockView } from './api.ts'
import ui from './zt-ui.module.css'

/** 收益 / 涨跌百分数：+1.23% / -0.50% / —。 */
export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

/** 正红负绿（A 股习惯）；0 或缺失不着色。 */
export function signClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return ''
  return value > 0 ? ui.up! : ui.down!
}

/** 20261103 / 2026-11-03 → 2026-11-03。 */
export function isoDate(value: string | undefined): string {
  const text = value ?? ''
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : text
}

/** 价格：A 股个股两位小数；ETF、港股低价股有第三位时保留三位。 */
export function formatPrice(value: number): string {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6 ? value.toFixed(2) : value.toFixed(3)
}

export function StockHead({ name, code, close, pctChg, priceNote }: {
  name: string
  code: string
  close?: number | undefined
  pctChg?: number | undefined
  /** 价格前的小字（如「11-04 收盘」：价格不是今天的实时价时写明）。 */
  priceNote?: string | undefined
}): ReactElement {
  return (
    <div className={ui.stockHead}>
      <div>
        <span className={ui.stockName}>{name || code}</span>
        <span className={ui.code}>{code}</span>
      </div>
      {close !== undefined ? (
        <div className={ui.px}>
          {priceNote !== undefined ? <span className={ui.muted} style={{ fontSize: 11, marginRight: 4 }}>{priceNote}</span> : null}
          {formatPrice(close)} <span className={signClass(pctChg)}>{pct(pctChg)}</span>
        </div>
      ) : null}
    </div>
  )
}

/** 砖块方块：红砖几块 / 绿砖几块 / 红砖翻绿（最多画 6 块）。 */
export function Bricks({ view }: { view: ClientZtStockView }): ReactElement | null {
  const label = view.brick ?? ''
  if (label === '') return null
  let count = 0
  let red = true
  if (label === '红砖翻绿') { // i18n-allow: 技能输出的砖块状态取值
    return (
      <div className={ui.bricks}>
        <i className={`${ui.brick} ${ui.brickRed}`} />
        <i className={`${ui.brick} ${ui.brickGreen}`} />
        <span>{label}</span>
      </div>
    )
  }
  if (view.brick_trend === 'RED') count = view.red_bricks ?? 0
  else if (view.brick_trend === 'GREEN') {
    red = false
    const digits = label.replace(/\D/g, '')
    count = digits === '' ? 0 : Number(digits)
  }
  return (
    <div className={ui.bricks}>
      {Array.from({ length: Math.min(count, 6) }, (_, i) => <i key={i} className={`${ui.brick} ${red ? ui.brickRed : ui.brickGreen}`} />)}
      {count > 6 ? '…' : null}
      <span>{label}</span>
    </div>
  )
}

/** 理由标签的颜色：「…选出」= 来源蓝，含 B1 = 买点红，其余灰。 */
export function reasonTagClass(reason: string): string {
  if (reason.endsWith('选出')) return `${ui.tag} ${ui.tagSrc}` // i18n-allow: 技能输出的理由后缀
  if (reason.includes('B1')) return `${ui.tag} ${ui.tagBuy}`
  return ui.tag!
}

/** 把走势按多空切成连续段（相邻段共用分界点，线不断开）。 */
export function stateRuns(states: readonly (string | undefined)[]): Array<{ bull: boolean; from: number; to: number }> {
  const runs: Array<{ bull: boolean; from: number; to: number }> = []
  states.forEach((state, i) => {
    const bull = (state ?? '').toUpperCase() === 'BULL'
    const last = runs[runs.length - 1]
    if (last !== undefined && last.bull === bull) last.to = i
    else runs.push({ bull, from: last === undefined ? i : i - 1, to: i })
  })
  return runs
}

/** 活跃市值走势小图：收盘价折线，多头段红、空头段绿（和 K 线背景同色系）。 */
export function Sparkline({ points }: { points: ReadonlyArray<{ close: number; state?: string | undefined }> }): ReactElement | null {
  const valid = points.filter(point => Number.isFinite(point.close))
  if (valid.length < 2) return null
  const values = valid.map(point => point.close)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const xy = (i: number): string => `${((i / (values.length - 1)) * 100).toFixed(2)},${(36 - ((values[i]! - min) / span) * 32 - 2).toFixed(2)}`
  const runs = stateRuns(valid.map(point => point.state))
  return (
    <svg className={ui.sparkline} viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
      {runs.map(run => (
        <polyline
          key={run.from}
          points={Array.from({ length: run.to - run.from + 1 }, (_, k) => xy(run.from + k)).join(' ')}
          fill="none"
          stroke={run.bull ? 'var(--dsw-futu-up, #e8384f)' : 'var(--dsw-futu-down, #1aa260)'}
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}

export interface AmvBar {
  date: string
  open?: number | undefined
  high?: number | undefined
  low?: number | undefined
  close: number
  state?: string | undefined
}

/** 序列里每根都有开高低收才画 K 线（旧报告只有收盘价）。 */
export function hasOhlc(points: readonly AmvBar[]): boolean {
  return points.length >= 2 && points.every(p => [p.open, p.high, p.low, p.close].every(v => v !== undefined && Number.isFinite(v) && v > 0))
}

/**
 * 活跃市值日 K 线（2026-11-05）：红涨绿跌的蜡烛，背景按当天多空状态铺浅红 / 浅绿；
 * 没有开高低收（旧报告）时退回按多空着色的折线。
 */
export function AmvKline({ points }: { points: readonly AmvBar[] }): ReactElement | null {
  if (!hasOhlc(points)) return <Sparkline points={points} />
  const width = 300
  const height = 96
  const padY = 5
  const lo = Math.min(...points.map(p => p.low!))
  const hi = Math.max(...points.map(p => p.high!))
  const span = hi - lo || 1
  const step = width / points.length
  const body = Math.max(1, step * 0.62)
  const y = (v: number): number => padY + ((hi - v) / span) * (height - padY * 2)
  const up = 'var(--dsw-futu-up, #e8384f)'
  const down = 'var(--dsw-futu-down, #1aa260)'
  return (
    <svg className={ui.kline} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="AMV">
      {points.map((p, i) => {
        const state = (p.state ?? '').toUpperCase()
        if (state !== 'BULL' && state !== 'BEAR') return null
        return <rect key={`bg${i}`} x={i * step} y={0} width={step + 0.3} height={height} fill={state === 'BULL' ? 'rgba(230,69,69,0.10)' : 'rgba(86,190,135,0.12)'} />
      })}
      {points.map((p, i) => {
        const cx = i * step + step / 2
        const rising = p.close >= p.open!
        const color = rising ? up : down
        const top = y(Math.max(p.open!, p.close))
        const bottom = y(Math.min(p.open!, p.close))
        return (
          <g key={p.date}>
            <line x1={cx} x2={cx} y1={y(p.high!)} y2={y(p.low!)} stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <rect x={cx - body / 2} y={top} width={body} height={Math.max(1, bottom - top)} fill={color} />
          </g>
        )
      })}
    </svg>
  )
}

/** YYYYMMDD 往后数 n 个工作日（不含节假日，只作「大约」提示用）。 */
export function addWeekdays(yyyymmdd: string, n: number): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return ''
  const day = new Date(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6)))
  let left = n
  while (left > 0) {
    day.setDate(day.getDate() + 1)
    if (day.getDay() !== 0 && day.getDay() !== 6) left -= 1
  }
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}
