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

export function StockHead({ name, code, close, pctChg }: { name: string; code: string; close?: number | undefined; pctChg?: number | undefined }): ReactElement {
  return (
    <div className={ui.stockHead}>
      <div>
        <span className={ui.stockName}>{name || code}</span>
        <span className={ui.code}>{code}</span>
      </div>
      {close !== undefined ? (
        <div className={ui.px}>
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

/** 活跃市值走势小图（收盘价折线）。 */
export function Sparkline({ points }: { points: ReadonlyArray<{ close: number }> }): ReactElement | null {
  const values = points.map(point => point.close).filter(Number.isFinite)
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const path = values.map((value, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(36 - ((value - min) / span) * 32 - 2).toFixed(2)}`).join(' ')
  return (
    <svg className={ui.sparkline} viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={path} fill="none" stroke="var(--dsw-futu-accent, #3b6fe0)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
