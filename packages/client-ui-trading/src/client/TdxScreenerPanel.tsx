/**
 * 通达信选股面板（右缘会话列容器的功能页签，2026-11-04）。
 *
 * 与宏观/预测市场同款模式：SessionRail 竖条按钮激活时原位覆盖对话列，与其余页签互斥；
 * 状态由 SessionRail 写 body[data-dshtrading-screener-open]，shell-pad.css 规则 17 隐去
 * 对话列内容；本组件是 fixed 面板，定位与宽度吃 frame 轨道变量（tdx-screener-panel.module.css）。
 *
 * 公式在通达信「公式管理器」里维护；面板只列出通达信里的自定义条件选股公式，按名调用
 * 通达信自己的公式引擎（桥 /tdx/*，经 zettaranc 技能命令行），所以结果与通达信一键选股一致，
 * 不需要把公式移植过来。通达信没开时明确提示，不把失败画成「没有选出股票」。
 *
 * - 点股票名：putHostSelection 切中栏图表（与左栏点击同源，SSE 'selection' 联动）；
 * - 技能复核：选出后经桥 /zt/review 按每日报告同一套规则复核，每只标「留下 / 剔除」与理由，
 *   留下的排在前面；技能不可用时照常列出通达信的原始结果；
 * - 存为分组：写进「通达信·公式名」分组（已存在就追加），复核完成时只存留下的；
 *   不碰报告管理的「今日选股」。
 */
import { useEffect, useState } from 'react'
import {
  addHostWatchlistGroupMember,
  createHostWatchlistGroup,
  fetchHostWatchlistGroups,
  fetchTdxFormulas,
  putHostSelection,
  runTdxSelect,
  runZtReview,
  type ClientTdxFormulas,
  type ClientTdxPick,
  type ClientTdxSelect,
  type ClientZtReview,
  type ClientZtReviewItem,
} from './api.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './tdx-screener-panel.module.css'

export type TdxScreenerTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface TdxScreenerPanelProps {
  t: TdxScreenerTranslate
  onClose(): void
}

/** 板块取值是技能命令行参数（与 tdx_local_client 板块名一致）。 */
const MAIN_BOARD: readonly string[] = ['主板'] // i18n-allow: 命令行参数取值，非 UI 文案
const GROUP_PREFIX = '通达信·' // i18n-allow: 分组名前缀写进用户数据，固定中文

/** 20261103 → 2026-11-03。 */
export function formatTradeDate(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value
}

export interface ReviewedPick {
  pick: ClientTdxPick
  /** 技能复核结果；复核没做或没覆盖到这只 = undefined。 */
  review?: ClientZtReviewItem
}

/** 复核状态：留下 / 剔除 / 待复核（没复核到、或本地数据早于选股日）。 */
export type ReviewState = 'kept' | 'dropped' | 'pending'

export function reviewState(item: ClientZtReviewItem | undefined): ReviewState {
  if (item === undefined || item.status === 'stale') return 'pending'
  return (item.status ?? (item.kept ? 'kept' : 'dropped')) === 'kept' ? 'kept' : 'dropped'
}

/** 一次复核最多几只（技能侧上限 120）；更多时分批请求，不让超出的被静默截掉。 */
export const REVIEW_BATCH = 120

/** 分批复核后合并；任何一批失败就整体按失败处理（不拿部分结果去筛）。 */
export async function reviewInBatches(codes: readonly string[], source: string, date: string): Promise<ClientZtReview | null> {
  const items: ClientZtReviewItem[] = []
  let amv: Extract<ClientZtReview, { available: true }>['amv'] = null
  for (let start = 0; start < codes.length; start += REVIEW_BATCH) {
    const part = await runZtReview(codes.slice(start, start + REVIEW_BATCH), source, date)
    if (part === null || !part.available) return part
    items.push(...part.items)
    amv = amv ?? part.amv
  }
  return { available: true, items, amv }
}

/** 把复核结果配到每只股票上；复核成功时按 留下 → 待复核 → 剔除 排（各自保持通达信的顺序）。 */
export function reviewedPicks(picks: readonly ClientTdxPick[], review: ClientZtReview | null | undefined): ReviewedPick[] {
  if (review === null || review === undefined || !review.available) return picks.map(pick => ({ pick }))
  const byCode = new Map(review.items.map(item => [item.code.toUpperCase(), item]))
  const rows: ReviewedPick[] = picks.map((pick) => {
    const item = byCode.get(pick.code.toUpperCase()) ?? byCode.get(pick.code.slice(0, 6))
    return item === undefined ? { pick } : { pick, review: item }
  })
  const rank: Record<ReviewState, number> = { kept: 0, pending: 1, dropped: 2 }
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank[reviewState(a.row.review)] - rank[reviewState(b.row.review)] || a.index - b.index)
    .map(entry => entry.row)
}

/** 存为分组：同名分组已存在就追加成员，不报重复。返回分组名；失败 = null。 */
export async function savePicksToGroup(formula: string, picks: readonly { code: string; name: string }[]): Promise<string | null> {
  const name = `${GROUP_PREFIX}${formula}`
  const created = await createHostWatchlistGroup(name)
  let id = created.ok ? created.group.id : undefined
  if (!created.ok && created.reason === 'duplicate') {
    const groups = await fetchHostWatchlistGroups()
    id = groups?.find(group => group.name === name)?.id
  }
  if (id === undefined) return null
  for (const pick of picks) {
    const ok = await addHostWatchlistGroupMember(id, 'cn', pick.code, pick.name || undefined)
    if (!ok) return null
  }
  return name
}

export function TdxScreenerPanel({ t, onClose }: TdxScreenerPanelProps) {
  const [formulas, setFormulas] = useState<ClientTdxFormulas | null | 'loading'>('loading')
  const [formula, setFormula] = useState('')
  const [mainOnly, setMainOnly] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ClientTdxSelect | null | undefined>(undefined)
  const [review, setReview] = useState<ClientZtReview | null | 'loading' | undefined>(undefined)
  const [saveNote, setSaveNote] = useState('')

  const loadFormulas = async (): Promise<void> => {
    setFormulas('loading')
    const list = await fetchTdxFormulas()
    setFormulas(list)
    if (list !== null && list.available && list.formulas.length > 0) {
      setFormula(current => (list.formulas.some(item => item.code === current) ? current : list.formulas[0]!.code))
    }
  }

  useEffect(() => { void loadFormulas() }, [])

  const run = async (): Promise<void> => {
    if (formula === '' || running) return
    setRunning(true)
    setSaveNote('')
    setResult(undefined)
    setReview(undefined)
    const selected = await runTdxSelect(formula, mainOnly ? MAIN_BOARD : [])
    setResult(selected)
    setRunning(false)
    if (selected !== null && selected.available && selected.picks.length > 0) {
      setReview('loading')
      setReview(await reviewInBatches(selected.picks.map(pick => pick.code), selected.formula, selected.tradeDate))
    }
  }

  const reviewDone = review !== 'loading' && review !== undefined && review !== null && review.available ? review : null
  const rows = result !== null && result !== undefined && result.available
    ? reviewedPicks(result.picks, review === 'loading' ? undefined : review)
    : []
  const counts = { kept: 0, dropped: 0, pending: 0 }
  if (reviewDone !== null) for (const row of rows) counts[reviewState(row.review)] += 1
  // 存分组：复核完成时存「没被剔除」的（留下 + 待复核），待复核的不能因为本地数据旧就丢掉
  const keptPicks = reviewDone !== null ? rows.filter(row => reviewState(row.review) !== 'dropped').map(row => row.pick) : null

  const save = async (): Promise<void> => {
    if (result === null || result === undefined || !result.available || result.picks.length === 0) return
    const picks = keptPicks ?? result.picks
    if (picks.length === 0) return
    const name = await savePicksToGroup(result.formula, picks)
    setSaveNote(name === null ? t('screener.saveFailed') : t('screener.saved', { name, count: picks.length }))
  }

  const asOf = reviewDone?.items.map(item => item.view.as_of ?? '').filter(Boolean).sort().pop() ?? ''

  const unavailableReason = formulas !== 'loading' && formulas !== null && !formulas.available ? formulas.reason : null

  return (
    <div className={css.panel} data-dshtrading-screener-panel="" role="panel" aria-label={t('stage.screener')}>
      <header className={css.head}>
        <strong className={css.title}>{t('stage.screener')}</strong>
        <span className={css.spacer} />
        <button type="button" className={css.closeBtn} aria-label={t('flash.close')} title={t('flash.close')} onClick={onClose}>×</button>
      </header>
      <div className={css.body}>
        <p className={css.hint}>{t('screener.hint')}</p>
        {formulas === 'loading' ? <p className={css.empty}>{t('screener.loading')}</p> : null}
        {formulas === null ? <p className={css.error}>{t('screener.error')}</p> : null}
        {unavailableReason !== null ? (
          <p className={css.error}>{t('screener.unavailable', { reason: unavailableReason })} {t('screener.openTdx')}</p>
        ) : null}
        {formulas !== 'loading' && formulas !== null && formulas.available && formulas.formulas.length === 0 ? (
          <p className={css.empty}>{t('screener.noFormulas')}</p>
        ) : null}
        <div className={css.controls}>
          <label className={css.field}>
            <span className={css.label}>{t('screener.formula')}</span>
            <select
              className={css.select}
              value={formula}
              disabled={formulas === 'loading' || formulas === null || !formulas.available || running}
              onChange={(event) => { setFormula(event.target.value) }}
            >
              {formulas !== 'loading' && formulas !== null && formulas.available
                ? formulas.formulas.map(item => (
                    <option key={item.code} value={item.code}>{item.name === item.code ? item.code : `${item.code} · ${item.name}`}</option>
                  ))
                : null}
            </select>
          </label>
          <button type="button" className={css.ghostBtn} onClick={() => { void loadFormulas() }} disabled={running}>
            {t('screener.refresh')}
          </button>
        </div>
        <div className={css.controls}>
          <div className={css.seg} role="group" aria-label={t('screener.boardAll')}>
            <button type="button" className={css.segBtn} aria-pressed={mainOnly} onClick={() => { setMainOnly(true) }}>{t('screener.boardMain')}</button>
            <button type="button" className={css.segBtn} aria-pressed={!mainOnly} onClick={() => { setMainOnly(false) }}>{t('screener.boardAll')}</button>
          </div>
          <span className={css.spacer} />
          <button type="button" className={css.primaryBtn} disabled={formula === '' || running} onClick={() => { void run() }}>
            {t('screener.run')}
          </button>
        </div>
        {running ? <p className={css.empty}>{t('screener.running')}</p> : null}
        {result === null ? <p className={css.error}>{t('screener.error')}</p> : null}
        {result !== null && result !== undefined && !result.available ? (
          <p className={css.error}>{t('screener.unavailable', { reason: result.reason })} {t('screener.openTdx')}</p>
        ) : null}
        {result !== null && result !== undefined && result.available ? (
          <>
            <div className={css.summaryRow}>
              <span className={css.summary}>
                {t('screener.summary', { date: formatTradeDate(result.tradeDate), scanned: result.scanned, count: result.picks.length })}
              </span>
              <span className={css.spacer} />
              {result.picks.length > 0 && (keptPicks === null || keptPicks.length > 0) ? (
                <button type="button" className={css.ghostBtn} disabled={review === 'loading'} onClick={() => { void save() }}>
                  {keptPicks === null ? t('screener.saveGroup') : t('screener.saveKept', { count: keptPicks.length })}
                </button>
              ) : null}
            </div>
            {review === 'loading' ? <p className={css.hint}>{t('screener.reviewing')}</p> : null}
            {reviewDone !== null ? (
              <p className={css.hint}>{t('screener.reviewSummary', { kept: counts.kept, dropped: counts.dropped, pending: counts.pending, asOf: formatTradeDate(asOf) || '—' })}</p>
            ) : null}
            {review !== 'loading' && review !== undefined && review !== null && !review.available ? (
              <p className={css.hint}>{t('screener.reviewUnavailable', { reason: review.reason })}</p>
            ) : null}
            {saveNote !== '' ? <p className={css.note}>{saveNote}</p> : null}
            {result.picks.length === 0 ? <p className={css.empty}>{t('screener.empty')}</p> : (
              <>
                <p className={css.hint}>{t('screener.openHint')}</p>
                <ul className={css.list}>
                  {rows.map(({ pick, review: item }) => (
                    <li key={pick.code}>
                      <button
                        type="button"
                        className={css.row}
                        data-dropped={reviewDone !== null && reviewState(item) === 'dropped' ? 'true' : undefined}
                        onClick={() => { void putHostSelection({ market: 'cn', symbol: pick.code, ...(pick.name ? { name: pick.name } : {}) }) }}
                      >
                        <span className={css.rowMain}>
                          <span className={css.name}>{pick.name || pick.code}</span>
                          <span className={css.code}>{pick.code}</span>
                          {reviewDone !== null ? (
                            <span className={css.tag} data-kept={{ kept: 'true', dropped: 'false', pending: 'pending' }[reviewState(item)]}>
                              {{ kept: t('screener.kept'), dropped: t('screener.dropped'), pending: t('screener.pending') }[reviewState(item)]}
                            </span>
                          ) : null}
                        </span>
                        {item !== undefined ? (
                          <span className={css.reason}>{reviewState(item) === 'kept' ? item.reasons.join(' · ') : item.reason}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
