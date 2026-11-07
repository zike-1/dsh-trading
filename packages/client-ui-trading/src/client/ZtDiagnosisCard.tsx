/**
 * Z哥诊断浮层与数据新鲜度（2026-11-04；港股作参考）。
 *
 * - 诊断浮层：图表工具条「Z哥诊断」打开，浮在 K 线右上角，不挤占图表。经桥 POST /zt/review
 *   让 zettaranc 技能按每日报告同一套规则算出要点（选股规则、砖块、B1、卖出信号、黄白线、BOLL、
 *   活跃市值），几秒出结果，不用大模型。「复制给 Z哥」把卡片整理成一段提问放进剪贴板（宿主没有
 *   往对话框预填文字的接口），角色据此解读，不必自己一步步跑命令。港股按同一套规则算，只作参考，
 *   卡片标出局限（规则按 A 股、未复权、活跃市值是 A 股指标）。
 * - 数据新鲜度：图表下方一行，写明日线本地通达信到哪天、之后是否来自行情接口、活跃市值到哪天。
 *
 * 视觉沿用每日 HTML 报告（zt-ui.module.css）；免责说明放在底部小字。
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { fetchDataStatus, runZtReview, type ClientDataStatus, type ClientZtAmv, type ClientZtReview, type ClientZtReviewItem } from './api.ts'
import type { MarketLocaleKey } from './contract.ts'
import { Bricks, StockHead, isoDate, reasonTagClass } from './ZtUi.tsx'
import ui from './zt-ui.module.css'

export type ZtTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

const dash = (value: string | undefined): string => (value !== undefined && value !== '' ? value : '—')

export interface DiagnosisLine {
  label: string
  value: string
}

/** 卡片标题行（复制给 Z哥的文字用）：名称、代码、数据日期、收盘与涨跌。 */
export function diagnosisHeader(t: ZtTranslate, item: ClientZtReviewItem): string {
  const view = item.view
  return t('zt.asOf', {
    name: item.name || item.code,
    code: item.code,
    date: isoDate(view.as_of),
    close: view.close ?? '—',
    pct: view.pct_chg ?? '—',
  })
}

function amvText(t: ZtTranslate, amv: ClientZtAmv | null): string {
  if (!amv?.state) return t('zt.none')
  return t('zt.amvState', {
    state: amv.state.toUpperCase() === 'BULL' ? t('amv.bull') : t('amv.bear'),
    days: amv.days_in_state ?? '—',
    since: amv.since ?? '—',
    date: amv.date ?? '—',
  })
}

/** 卡片各行（纯函数，便于测试与复制成提问）。 */
export function diagnosisLines(t: ZtTranslate, item: ClientZtReviewItem, amv: ClientZtAmv | null): DiagnosisLine[] {
  const view = item.view
  const sells = view.sells ?? []
  const b1 = view.b1_today
    ? [t('zt.b1Today', { kind: view.b1_today, streak: view.b1_streak ?? 1 }), view.b1_text ?? ''].filter(Boolean).join(' · ')
    : t('zt.b1None')
  return [
    {
      label: t('zt.label.verdict'),
      value: item.kept ? t('zt.verdictKept', { reasons: item.reasons.join(' · ') || '—' }) : t('zt.verdictDropped', { reason: item.reason }),
    },
    { label: t('zt.label.brick'), value: [view.brick, view.brick_action].filter(Boolean).join(' · ') || '—' },
    { label: t('zt.label.b1'), value: b1 },
    { label: t('zt.label.add'), value: dash(view.add_verdict) },
    { label: t('zt.label.sells'), value: sells.length > 0 ? sells.join(' · ') : t('zt.none') },
    { label: t('zt.label.line'), value: dash(view.line) },
    { label: t('zt.label.boll'), value: `${dash(view.boll_day)} / ${dash(view.boll_week)}` },
    { label: t('zt.label.flyaway'), value: dash(view.flyaway) },
    { label: t('zt.label.macd'), value: view.macd_veto ? t('zt.macdVeto') : t('zt.none') },
    { label: t('zt.label.amv'), value: amvText(t, amv) },
  ]
}

/** 复制给 Z哥角色的提问：卡片全文（港股带上参考说明）+「直接据此解读，不要再调用工具重算」。 */
export function diagnosisPrompt(t: ZtTranslate, item: ClientZtReviewItem, amv: ClientZtAmv | null): string {
  const lines = [diagnosisHeader(t, item), ...diagnosisLines(t, item, amv).map(line => `${line.label}: ${line.value}`), ...(item.notes ?? [])]
  return t('zt.prompt', { name: item.name || item.code, code: item.code, card: lines.join('\n') })
}

/** 诊断用的是本地日线最后一根：不是今天的就写明「MM-DD 收盘」，免得和顶部的实时价对不上。 */
export function closeNote(t: ZtTranslate, asOf: string | undefined, now: Date = new Date()): string | undefined {
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  if (asOf === undefined || !/^\d{8}$/.test(asOf) || asOf === today) return undefined
  return t('zt.closeOf', { date: `${asOf.slice(4, 6)}-${asOf.slice(6)}` })
}

/** 剪贴板接口被拒（权限策略、内嵌浏览器）时的退路：选中一个看不见的文本框再执行复制。 */
export function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    return typeof document.execCommand === 'function' && document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

const POS_KEY = 'dshtrading.ztCard.pos'

/**
 * 已算过的诊断结果（按代码，页面打开期间有效）：切到别的股票再切回来直接显示，不重算；
 * 「重新计算」才重新请求。技能数据一天只变一次（收盘后），所以缓存也带上算的时刻，卡片里写明。
 */
const reviewCache = new Map<string, { result: ClientZtReview; at: number }>()

/** 测试用：清空缓存。 */
export function clearZtReviewCache(): void {
  reviewCache.clear()
}

/** 收盘后数据（盘后下载、补当天 K 线）一般在这之后才齐。 */
const AFTER_CLOSE_MINUTES = 15 * 60 + 30

/**
 * 缓存的诊断还能不能用：同一个自然日、且没有跨过收盘（15:30 之前算的，到了 15:30 之后要按收盘数据重算）。
 * 否则早上打开看到的还是昨天收盘算的结论，晚上看到的还是盘中算的。
 */
export function cacheStillFresh(computedAt: number, now: number = Date.now()): boolean {
  const a = new Date(computedAt)
  const b = new Date(now)
  if (a.toDateString() !== b.toDateString()) return false
  const minutes = (d: Date): number => d.getHours() * 60 + d.getMinutes()
  return !(minutes(a) < AFTER_CLOSE_MINUTES && minutes(b) >= AFTER_CLOSE_MINUTES)
}

interface Pos { x: number; y: number }

/** 记住的浮窗位置（拖过才有）；读不到 / 无效 = null，用默认的右上方。 */
function readPos(): Pos | null {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as Partial<Pos> | null
    return raw !== null && Number.isFinite(raw.x) && Number.isFinite(raw.y) ? { x: raw.x!, y: raw.y! } : null
  } catch {
    return null
  }
}

function writePos(pos: Pos | null): void {
  try {
    if (pos === null) localStorage.removeItem(POS_KEY)
    else localStorage.setItem(POS_KEY, JSON.stringify(pos))
  } catch {
    // 存不了（隐私模式等）就只在本次打开期间有效
  }
}

/** 浮窗留在视口里：至少露出标题栏。 */
export function clampPos(pos: Pos, width: number, viewport: { width: number; height: number }): Pos {
  return {
    x: Math.min(Math.max(0, pos.x), Math.max(0, viewport.width - width)),
    y: Math.min(Math.max(0, pos.y), Math.max(0, viewport.height - 40)),
  }
}

export interface ZtDiagnosisCardProps {
  t: ZtTranslate
  /** 600036.SH / 00700.HK 形式。 */
  symbol: string
  /** 工作台里的股票名（技能读不到港股简称时用它）。 */
  name?: string | undefined
  onClose(): void
}

export function ZtDiagnosisCard({ t, symbol, name, onClose }: ZtDiagnosisCardProps) {
  const [state, setState] = useState<ClientZtReview | null | 'loading'>('loading')
  const [note, setNote] = useState('')
  const [round, setRound] = useState(0)
  /** 「重新计算」点过：下一次请求跳过缓存（只作用一次，换股票后照常先查缓存）。 */
  const forceRef = useRef(false)
  const [computedAt, setComputedAt] = useState<number | null>(null)
  const [pos, setPos] = useState<Pos | null>(readPos)
  const cardRef = useRef<HTMLElement | null>(null)

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button') !== null) return
    const card = cardRef.current
    if (card === null) return
    const rect = card.getBoundingClientRect()
    const dx = event.clientX - rect.left
    const dy = event.clientY - rect.top
    let last: Pos = { x: rect.left, y: rect.top }
    const move = (e: PointerEvent): void => {
      last = clampPos({ x: e.clientX - dx, y: e.clientY - dy }, rect.width, { width: window.innerWidth, height: window.innerHeight })
      setPos(last)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      writePos(last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    event.preventDefault()
  }

  const resetPos = (): void => {
    setPos(null)
    writePos(null)
  }

  useEffect(() => {
    let cancelled = false
    setNote('')
    const key = symbol.toUpperCase()
    const force = forceRef.current
    forceRef.current = false
    const hit = force ? undefined : reviewCache.get(key)
    const cached = hit !== undefined && cacheStillFresh(hit.at) ? hit : undefined
    if (cached !== undefined) {
      setState(cached.result)
      setComputedAt(cached.at)
      return () => { cancelled = true }
    }
    setState('loading')
    void runZtReview([symbol]).then((result) => {
      if (cancelled) return
      setState(result)
      const at = Date.now()
      setComputedAt(at)
      // 只缓存算成功的；失败（技能不在、请求出错）下次再试
      if (result !== null && result.available) reviewCache.set(key, { result, at })
    })
    return () => { cancelled = true }
  }, [symbol, round])


  const raw = state !== 'loading' && state !== null && state.available ? state.items[0] : undefined
  const item = raw === undefined ? undefined : { ...raw, name: raw.name && raw.name !== raw.code ? raw.name : (name || raw.code) }
  const amv = state !== 'loading' && state !== null && state.available ? state.amv : null
  const hk = symbol.toUpperCase().endsWith('.HK')

  const copy = async (): Promise<void> => {
    if (item === undefined) return
    const text = diagnosisPrompt(t, item, amv)
    try {
      await navigator.clipboard.writeText(text)
      setNote(t('zt.copied'))
    } catch {
      setNote(legacyCopy(text) ? t('zt.copied') : t('zt.copyFailed'))
    }
  }

  const view = item?.view
  const sells = view?.sells ?? []
  const amvBull = amv?.state?.toUpperCase() === 'BULL'

  return (
    <section
      ref={cardRef}
      className={`${ui.card} ${ui.floating}`}
      style={pos === null ? undefined : { left: pos.x, top: pos.y, right: 'auto' }}
      data-dshtrading-zt-card=""
      aria-label={t('zt.diagnose')}
    >
      <div className={ui.floatHead} title={t('zt.dragHint')} onPointerDown={startDrag} onDoubleClick={resetPos}>
        <span>{t('zt.diagnose')}</span>
        {hk ? <span className={`${ui.tag} ${ui.tagWarn}`}>{t('zt.hkTag')}</span> : null}
        <span className={ui.spacer} />
        <button type="button" className={ui.iconBtn} aria-label={t('flash.close')} title={t('flash.close')} onClick={onClose}>×</button>
      </div>

      {state === 'loading' ? <div className={ui.empty}>{t('zt.loading')}</div> : null}
      {state === null || (state !== 'loading' && state.available && item === undefined) ? <div className={ui.note}>{t('zt.failed')}</div> : null}
      {state !== 'loading' && state !== null && !state.available ? <div className={ui.note}>{t('zt.unavailable', { reason: state.reason })}</div> : null}

      {item !== undefined && view !== undefined ? (
        <>
          <StockHead name={item.name} code={item.code} close={view.close} pctChg={view.pct_chg} priceNote={closeNote(t, view.as_of)} />
          <div className={ui.tags}>
            {item.kept
              ? <span className={`${ui.tag} ${ui.tagBuy}`}>{t('zt.kept')}</span>
              : <span className={`${ui.tag} ${ui.tagSell}`}>{t('zt.verdictDropped', { reason: item.reason })}</span>}
            {amv?.state ? (
              <span className={`${ui.tag} ${amvBull ? ui.tagBuy : ui.tagSell}`}>
                {t('zt.amvChip', { state: amvBull ? t('amv.bull') : t('amv.bear'), days: amv.days_in_state ?? '—' })}
              </span>
            ) : null}
            <span className={`${ui.tag}`}>{t('zt.asOfShort', { date: isoDate(view.as_of) })}</span>
          </div>
          {item.kept && item.reasons.length > 0 ? (
            <div className={ui.tags}>{item.reasons.map(reason => <span key={reason} className={reasonTagClass(reason)}>{reason}</span>)}</div>
          ) : null}
          <Bricks view={view} />
          <div className={ui.rows}>
            <div className={ui.row}>
              <span className={ui.k}>{t('zt.label.b1')}</span>
              <span className={ui.v}>{view.b1_today ? t('zt.b1Today', { kind: view.b1_today, streak: view.b1_streak ?? 1 }) : <span className={ui.muted}>{t('zt.b1None')}</span>}</span>
            </div>
            {view.add_verdict ? (
              <div className={ui.row}><span className={ui.k}>{t('zt.label.add')}</span><span className={ui.v}><span className={`${ui.tag} ${ui.tagBuy}`}>{view.add_verdict}</span></span></div>
            ) : null}
            <div className={ui.row}>
              <span className={ui.k}>{t('zt.label.sellsShort')}</span>
              <span className={`${ui.v} ${ui.tags}`}>
                {sells.length > 0 ? sells.map(sell => <span key={sell} className={`${ui.tag} ${ui.tagSell}`}>{sell}</span>) : <span className={ui.muted}>{t('zt.none')}</span>}
              </span>
            </div>
            <div className={ui.row}><span className={ui.k}>{t('zt.label.line')}</span><span className={ui.v}>{dash(view.line)}</span></div>
            <div className={ui.row}><span className={ui.k}>BOLL</span><span className={`${ui.v} ${ui.muted}`}>{t('zt.bollValue', { day: dash(view.boll_day), week: dash(view.boll_week) })}</span></div>
            {view.flyaway ? (
              <div className={ui.row}><span className={ui.k}>{t('zt.label.flyaway')}</span><span className={ui.v}><span className={`${ui.tag} ${ui.tagWarn}`}>{view.flyaway}</span></span></div>
            ) : null}
            {view.macd_veto ? (
              <div className={ui.row}><span className={ui.k}>MACD</span><span className={ui.v}><span className={`${ui.tag} ${ui.tagSell}`}>{t('zt.macdVeto')}</span></span></div>
            ) : null}
          </div>
          {(item.notes ?? []).length > 0 ? (
            <div className={ui.lead}>{(item.notes ?? []).map(text => <div key={text}>· {text}</div>)}</div>
          ) : null}
        </>
      ) : null}

      <div className={ui.actions}>
        <button type="button" className={ui.btnPrimary} disabled={item === undefined} onClick={() => { void copy() }}>{t('zt.copy')}</button>
        <button type="button" className={ui.btn} disabled={state === 'loading'} onClick={() => { forceRef.current = true; setRound(value => value + 1) }}>{t('zt.refresh')}</button>
        <span className={ui.fine}>
          {computedAt !== null ? `${t('zt.computedAt', { time: new Date(computedAt).toTimeString().slice(0, 5) })} · ` : ''}{t('zt.disclaimer')}
        </span>
      </div>
      {note !== '' ? <div className={ui.lead}>{note}</div> : null}
    </section>
  )
}

/** 数据新鲜度一行的文字：本地日线到哪天、之后是否来自行情接口。 */
export function freshnessText(t: ZtTranslate, localThrough: string | null, lastBarDate: string | null): string {
  if (localThrough === null) return t('fresh.noLocal')
  return lastBarDate !== null && lastBarDate > localThrough ? t('fresh.tail', { date: localThrough }) : t('fresh.local', { date: localThrough })
}

export interface DataFreshnessProps {
  t: ZtTranslate
  symbol: string
  /** 图上最后一根日线的日期（YYYY-MM-DD）；还没取到 = null。 */
  lastBarDate: string | null
}

/** 图表下方的数据新鲜度：换标的时重取，之后每 5 分钟刷新（活跃市值晚上才更新）。 */
export function DataFreshness({ t, symbol, lastBarDate }: DataFreshnessProps) {
  const [status, setStatus] = useState<ClientDataStatus | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const load = (): void => {
      void fetchDataStatus(symbol, controller.signal).then((next) => { if (!controller.signal.aborted && next !== null) setStatus(next) })
    }
    setStatus(null)
    load()
    const timer = setInterval(load, 5 * 60_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [symbol])

  if (status === null) return null
  const parts = [freshnessText(t, status.localThrough, lastBarDate)]
  if (status.amvThrough !== null) parts.push(t('fresh.amv', { date: status.amvThrough }))
  const text = parts.join(' · ')
  // 2026-11-05：外层只留更新时间，数据来源收进这个小图标（悬停 / 读屏看全文）
  return (
    <span role="status" className={ui.freshnessIcon} title={text} aria-label={text} data-dshtrading-freshness="">
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <rect x="7.3" y="7" width="1.4" height="4.6" rx="0.5" fill="currentColor" />
        <circle cx="8" cy="4.9" r="0.9" fill="currentColor" />
      </svg>
    </span>
  )
}
