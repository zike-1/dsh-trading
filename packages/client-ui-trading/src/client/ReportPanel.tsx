/**
 * 每日报告面板（右缘会话列容器的功能页签 8 号，2026-11-04）。
 *
 * 与选股页签同款模式：SessionRail 竖条按钮激活时原位覆盖对话列，与其余页签互斥；
 * 状态由 SessionRail 写 body[data-dshtrading-report-open]，shell-pad.css 规则 18 隐去对话列内容。
 *
 * - 每日报告：读 zettaranc 技能写的 data/YYYY-MM-DD.json（桥 /reports、/reports/day），视觉沿用每日
 *   HTML 报告（zt-ui.module.css）：活跃市值徽章与走势、持仓卡片、今日选股（留下的写理由，剔除的折叠）、
 *   红利组 B1、入选后表现；点股票卡片切中栏图表；前一天 / 后一天 / 选日期。
 * - 前向检验：桥 /zt/forward-test（技能命令行算）：入选后 5 / 10 日对比同日随机基准、上证与被剔除那组，
 *   样本不够时写明。
 *
 * 只读；报告是规则的机械计算，不构成投资建议（底部小字）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  fetchForwardTest,
  fetchReportDay,
  fetchReportDays,
  putHostSelection,
  type ClientForwardGroup,
  type ClientForwardTest,
  type ClientForwardTestResult,
  type ClientReport,
  type ClientReportDay,
  type ClientReportDays,
} from './api.ts'
import type { MarketLocaleKey } from './contract.ts'
import { Bricks, Sparkline, StockHead, isoDate, pct, reasonTagClass, signClass } from './ZtUi.tsx'
import shared from './tdx-screener-panel.module.css'
import ui from './zt-ui.module.css'

export { pct } from './ZtUi.tsx'

export type ReportTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

/** 比例（已经是百分数）：56.0% / —。 */
function rate(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`
}

/** 6 位代码 → 600795.SH 形式（点股票切图用）；已带后缀的原样。 */
export function toSymbol(code: string): string {
  if (code.includes('.')) return code
  if (/^(4|8|92)/.test(code)) return `${code}.BJ`
  return /^(5|6|9)/.test(code) ? `${code}.SH` : `${code}.SZ`
}

function open(code: string, name?: string | undefined): void {
  void putHostSelection({ market: code.toUpperCase().endsWith('.HK') ? 'hk' : 'cn', symbol: toSymbol(code), ...(name ? { name } : {}) })
}

function Section({ title, count, lead, children }: { title: string; count?: string | undefined; lead?: string | undefined; children: ReactNode }) {
  return (
    <section>
      <h3 className={ui.sectionTitle}>{title}{count !== undefined ? <span className={ui.count}>{count}</span> : null}</h3>
      {lead !== undefined ? <p className={ui.lead}>{lead}</p> : null}
      {children}
    </section>
  )
}

function AmvCard({ t, amv, behind }: { t: ReportTranslate; amv: ClientReport['amv']; behind: boolean }) {
  if (!amv?.state) return <div className={`${ui.card} ${ui.empty}`}>{t('report.amvMissing')}</div>
  const bull = amv.state.toUpperCase() === 'BULL'
  return (
    <div className={ui.card}>
      <div className={ui.statLabel}>{t('report.amvTitle')} · {amv.date ?? '—'}</div>
      <div>
        <span className={`${ui.state} ${bull ? ui.stateBull : ui.stateBear}`}>{bull ? t('report.stateBull') : t('report.stateBear')}</span>
      </div>
      <div className={ui.lead}>
        {t('report.amvMeta', { days: amv.days_in_state ?? '—', since: amv.since ?? '—' })} <span className={signClass(amv.pct_chg)}>{pct(amv.pct_chg)}</span>
      </div>
      <div className={ui.rows}>
        {amv.bull_at !== null && amv.bull_at !== undefined ? <div>{t('report.toBull')} <b className={ui.up}>≥ {pct(amv.bull_at)}</b></div> : null}
        {amv.bear_at !== null && amv.bear_at !== undefined ? <div>{t('report.toBear')} <b className={ui.down}>≤ {pct(amv.bear_at)}</b></div> : null}
      </div>
      {amv.series !== undefined ? <Sparkline points={amv.series} /> : null}
      {behind ? <div className={ui.note}>{t('report.amvBehind')}</div> : null}
      <div className={ui.lead}>{t('report.amvLead')}</div>
    </div>
  )
}

export function ReportView({ t, report }: { t: ReportTranslate; report: ClientReport }) {
  const holdings = report.holdings ?? []
  const picks = report.picks ?? []
  const dropped = report.dropped ?? []
  const dividend = report.dividend?.b1 ?? []
  const follow = Object.entries(report.follow_up?.summary ?? {})
  return (
    <>
      <p className={ui.lead}>{t('report.meta', { data: isoDate(report.data_date), at: report.generated_at ?? '—' })}</p>
      {report.behind_days ? <div className={ui.note}>{t('report.behind', { days: report.behind_days })}</div> : null}

      <AmvCard t={t} amv={report.amv} behind={report.amv_behind === true} />

      <Section title={t('report.holdingsTitle')} count={t('report.countStocks', { count: holdings.length })} lead={t('report.holdingsLead')}>
        {holdings.length === 0 ? <div className={ui.empty}>{t('report.empty')}</div> : (
          <div className={ui.cards}>
            {holdings.map((item) => {
              const today = item.sells_today ?? []
              const earlier = (item.sells ?? []).filter(sell => !today.includes(sell))
              // 分析失败：只写原因，不显示价格和结论（默认值 0 价、无信号不是真的「没有卖出信号」）
              if (item.error) {
                return (
                  <div key={item.code} className={`${ui.card} ${ui.clickable}`} role="button" tabIndex={0} onClick={() => { open(item.code, item.name) }}>
                    <StockHead name={item.name ?? ''} code={item.code} />
                    <div className={ui.note}>{t('report.analyzeFailed', { reason: item.error })}</div>
                  </div>
                )
              }
              return (
                <div key={item.code} className={`${ui.card} ${ui.clickable}`} role="button" tabIndex={0} onClick={() => { open(item.code, item.name) }}>
                  <StockHead name={item.name ?? ''} code={item.code} close={item.close} pctChg={item.pct_chg} />
                  <Bricks view={item} />
                  <div className={ui.rows}>
                    <div className={ui.row}><span className={ui.k}>{t('zt.label.add')}</span><span className={ui.v}>{item.add_verdict ? <span className={`${ui.tag} ${ui.tagBuy}`}>{item.add_verdict}</span> : <span className={ui.muted}>{t('report.noAdd')}</span>}</span></div>
                    <div className={ui.row}><span className={ui.k}>{t('zt.label.flyaway')}</span><span className={ui.v}>{item.flyaway ? <span className={`${ui.tag} ${ui.tagWarn}`}>{item.flyaway}</span> : <span className={ui.muted}>{t('zt.none')}</span>}</span></div>
                    <div className={ui.row}>
                      <span className={ui.k}>{t('zt.label.sellsShort')}</span>
                      <span className={`${ui.v} ${ui.tags}`}>
                        {today.map(sell => <span key={sell} className={`${ui.tag} ${ui.tagSell}`}>{sell}</span>)}
                        {earlier.length > 0 ? <span className={ui.muted}>{t('report.earlierSells', { list: earlier.join(' · ') })}</span> : null}
                        {today.length === 0 && earlier.length === 0 ? <span className={ui.muted}>{t('zt.none')}</span> : null}
                      </span>
                    </div>
                    <div className={ui.row}><span className={ui.k}>BOLL</span><span className={`${ui.v} ${ui.muted}`}>{t('zt.bollValue', { day: item.boll_day ?? '—', week: item.boll_week ?? '—' })}</span></div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <Section title={t('report.picksTitle')} count={t('report.countStocks', { count: picks.length })} lead={t('report.picksLead')}>
        {picks.length === 0 ? <div className={ui.empty}>{t('report.empty')}</div> : (
          <div className={ui.cards}>
            {picks.map(item => (
              <div key={item.code} className={`${ui.card} ${ui.clickable}`} role="button" tabIndex={0} onClick={() => { open(item.code, item.name) }}>
                <StockHead name={item.name ?? ''} code={item.code} close={item.close} pctChg={item.pct_chg} />
                <div className={ui.tags}>{(item.reasons ?? []).map(reason => <span key={reason} className={reasonTagClass(reason)}>{reason}</span>)}</div>
              </div>
            ))}
          </div>
        )}
        {dropped.length > 0 ? (
          <details>
            <summary className={ui.lead}>{t('report.dropped', { count: dropped.length })}</summary>
            {dropped.map(item => (
              <div key={item.code} className={ui.listRow} role="button" tabIndex={0} onClick={() => { open(item.code, item.name) }}>
                <span className={ui.stockName}>{item.name || item.code}</span>
                <span className={ui.code}>{item.code}</span>
                <span className={ui.listReason}>{item.reason ?? ''}</span>
              </div>
            ))}
          </details>
        ) : null}
      </Section>

      <Section title={t('report.dividendTitle')} count={t('report.dividendCount', { count: dividend.length, total: report.dividend?.total ?? 0 })} lead={t('report.dividendLead')}>
        {dividend.length === 0 ? <div className={ui.empty}>{t('report.dividendEmpty')}</div> : (
          <div className={ui.cards}>
            {dividend.map(item => (
              <div key={item.code} className={`${ui.card} ${ui.clickable}`} role="button" tabIndex={0} onClick={() => { open(item.code, item.name) }}>
                <StockHead name={item.name ?? ''} code={item.code} close={item.close} pctChg={item.pct_chg} />
                <div className={ui.tags}>
                  {item.industry ? <span className={ui.tag}>{item.industry}</span> : null}
                  <span className={`${ui.tag} ${ui.tagBuy}`}>{(item.b1_streak ?? 0) > 1 ? t('report.b1Streak', { n: item.b1_streak }) : (item.b1_text || item.b1_today)}</span>
                  {item.brick ? <span className={ui.tag}>{item.brick}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('report.followTitle')} lead={t('report.followLead')}>
        {follow.length === 0 ? <div className={ui.empty}>{t('report.followEmpty')}</div> : follow.map(([n, row]) => (
          <div key={n} className={ui.card} style={{ marginBottom: 8 }}>
            <div className={ui.statLabel}>{t('report.followHorizon', { n, count: row.count ?? 0 })}</div>
            <div className={ui.stats}>
              <div className={ui.stat}><div className={ui.statLabel}>{t('report.statAvg')}</div><div className={`${ui.statValue} ${signClass(row.avg)}`}>{pct(row.avg)}</div></div>
              <div className={ui.stat}><div className={ui.statLabel}>{t('report.statWin')}</div><div className={ui.statValue}>{rate(row.win_rate)}</div></div>
              <div className={ui.stat}><div className={ui.statLabel}>{t('report.statExcess')}</div><div className={`${ui.statValue} ${signClass(row.avg_excess)}`}>{pct(row.avg_excess)}</div></div>
            </div>
          </div>
        ))}
      </Section>

      <div className={ui.footnote}>
        {report.rules?.exclude ? <div>{t('report.rules', { rules: report.rules.exclude })}</div> : null}
        <div>{t('report.disclaimer')}</div>
      </div>
    </>
  )
}

/** 结论标签颜色：按技能输出的结论文字（跑赢 / 跑输 / 样本不足）。 */
function verdictClass(text: string | undefined): string {
  if (text === undefined) return ui.tag!
  if (text.includes('跑赢')) return `${ui.tag} ${ui.tagBuy}` // i18n-allow: 技能输出的结论关键词
  if (text.includes('跑输')) return `${ui.tag} ${ui.tagSell}` // i18n-allow: 技能输出的结论关键词
  if (text.includes('样本不足')) return `${ui.tag} ${ui.tagWarn}` // i18n-allow: 技能输出的结论关键词
  return ui.tag!
}

function GroupRow({ label, group }: { label: string; group: ClientForwardGroup }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{group.days}</td>
      <td>{group.count}</td>
      <td className={signClass(group.avg)}>{pct(group.avg)}</td>
      <td>{rate(group.win_rate)}</td>
      <td>{rate(group.beat_random_rate)}</td>
    </tr>
  )
}

export function ForwardView({ t, data }: { t: ReportTranslate; data: ClientForwardTest }) {
  const horizons = data.horizons ?? []
  const first = horizons[0]
  return (
    <>
      <p className={ui.lead}>{t('forward.meta', { days: data.report_days ?? 0, pending: data.pending_days ?? 0, through: isoDate(data.local_through) })}</p>
      {horizons.map((n) => {
        const row = data.summary?.[String(n)]
        if (row === undefined) return null
        const ci = row.picks.excess_ci
        return (
          <div key={n} className={ui.card} style={{ marginBottom: 8 }}>
            <div className={ui.stockHead}>
              <span className={ui.stockName}>{t('forward.horizon', { n })}</span>
              {row.verdict ? <span className={verdictClass(row.verdict)}>{row.verdict}</span> : null}
            </div>
            <div className={ui.stats}>
              <div className={ui.stat}>
                <div className={ui.statLabel}>{t('forward.statPicks')}</div>
                <div className={`${ui.statValue} ${signClass(row.picks.avg)}`}>{pct(row.picks.avg)}</div>
                <div className={ui.statHint}>{t('forward.statCount', { count: row.picks.count, days: row.picks.days })}</div>
              </div>
              <div className={ui.stat}>
                <div className={ui.statLabel}>{t('forward.statRandom')}</div>
                <div className={`${ui.statValue} ${signClass(row.random_avg)}`}>{pct(row.random_avg)}</div>
                <div className={ui.statHint}>{t('forward.statBench', { value: pct(row.bench_avg) })}</div>
              </div>
              <div className={ui.stat}>
                <div className={ui.statLabel}>{t('forward.statExcess')}</div>
                <div className={`${ui.statValue} ${signClass(row.picks.excess_vs_random)}`}>{pct(row.picks.excess_vs_random)}</div>
                <div className={ui.statHint}>{ci ? t('forward.ci', { low: pct(ci[0]), high: pct(ci[1]) }) : t('forward.noCi')}</div>
              </div>
            </div>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>{t('forward.colGroup')}</th>
                  <th>{t('forward.colDays')}</th>
                  <th>{t('forward.colCount')}</th>
                  <th>{t('forward.colAvg')}</th>
                  <th>{t('forward.colWin')}</th>
                  <th>{t('forward.colBeat')}</th>
                </tr>
              </thead>
              <tbody>
                <GroupRow label={t('forward.picks')} group={row.picks} />
                <GroupRow label={t('forward.dropped')} group={row.dropped} />
              </tbody>
            </table>
          </div>
        )
      })}
      {first !== undefined && data.by_source !== undefined && Object.keys(data.by_source).length > 0 ? (
        <Section title={t('forward.bySource', { n: first })}>
          <table className={ui.table}>
            <tbody>
              {Object.entries(data.by_source).map(([name, groups]) => {
                const group = groups[String(first)]
                return group === undefined ? null : <GroupRow key={name} label={name} group={group} />
              })}
            </tbody>
          </table>
        </Section>
      ) : null}
      {data.days !== undefined && data.days.length > 0 && first !== undefined ? (
        <Section title={t('forward.days')}>
          {data.days.map(day => (
            <div key={day.date} className={ui.listRow} style={{ cursor: 'default' }}>
              <span>{isoDate(day.date)}</span>
              <span className={ui.muted}>{t('forward.dayCounts', { picks: day.picks, dropped: day.dropped })}</span>
              <span className={ui.listReason}>
                {t('forward.dayReturns', { picks: pct(day.picks_avg[String(first)]), random: pct(day.universe[String(first)]), dropped: pct(day.dropped_avg[String(first)]) })}
              </span>
            </div>
          ))}
        </Section>
      ) : null}
      <div className={ui.footnote}>{(data.notes ?? []).map(note => <div key={note}>{note}</div>)}</div>
    </>
  )
}

export interface ReportPanelProps {
  t: ReportTranslate
  onClose(): void
}

export function ReportPanel({ t, onClose }: ReportPanelProps) {
  const [tab, setTab] = useState<'report' | 'forward'>('report')
  const [days, setDays] = useState<ClientReportDays | null | 'loading'>('loading')
  const [date, setDate] = useState('')
  const [report, setReport] = useState<ClientReportDay | null | 'loading' | undefined>(undefined)
  const [forward, setForward] = useState<ClientForwardTestResult | null | 'loading' | undefined>(undefined)
  const [forwardRound, setForwardRound] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void fetchReportDays(controller.signal).then((list) => {
      if (controller.signal.aborted) return
      setDays(list)
      if (list !== null && list.available && list.days.length > 0) setDate(list.days[0]!)
    })
    return () => { controller.abort() }
  }, [])

  useEffect(() => {
    if (date === '') return
    const controller = new AbortController()
    setReport('loading')
    void fetchReportDay(date, controller.signal).then((day) => { if (!controller.signal.aborted) setReport(day) })
    return () => { controller.abort() }
  }, [date])

  useEffect(() => {
    if (tab !== 'forward') return
    const controller = new AbortController()
    setForward('loading')
    void fetchForwardTest(controller.signal).then((result) => { if (!controller.signal.aborted) setForward(result) })
    return () => { controller.abort() }
  }, [tab, forwardRound])

  const dayList = days !== 'loading' && days !== null && days.available ? days.days : []
  const index = dayList.indexOf(date)
  const older = index >= 0 && index + 1 < dayList.length ? dayList[index + 1] : undefined
  const newer = index > 0 ? dayList[index - 1] : undefined

  return (
    <div className={shared.panel} data-dshtrading-report-panel="" role="panel" aria-label={t('stage.report')}>
      <header className={shared.head}>
        <strong className={shared.title}>{t('stage.report')}</strong>
        <span className={shared.spacer} />
        <button type="button" className={shared.closeBtn} aria-label={t('flash.close')} title={t('flash.close')} onClick={onClose}>×</button>
      </header>
      <div className={shared.body}>
        <div className={shared.controls}>
          <div className={shared.seg} role="group" aria-label={t('stage.report')}>
            <button type="button" className={shared.segBtn} aria-pressed={tab === 'report'} onClick={() => { setTab('report') }}>{t('report.tabReport')}</button>
            <button type="button" className={shared.segBtn} aria-pressed={tab === 'forward'} onClick={() => { setTab('forward') }}>{t('report.tabForward')}</button>
          </div>
          <span className={shared.spacer} />
          {tab === 'forward' ? (
            <button type="button" className={shared.ghostBtn} disabled={forward === 'loading'} onClick={() => { setForwardRound(value => value + 1) }}>{t('forward.refresh')}</button>
          ) : null}
        </div>
        {tab === 'report' && dayList.length > 0 ? (
          <div className={shared.controls}>
            <button type="button" className={shared.ghostBtn} disabled={older === undefined} onClick={() => { if (older !== undefined) setDate(older) }}>{t('report.prev')}</button>
            <select className={shared.select} aria-label={t('report.date')} value={date} onChange={(event) => { setDate(event.target.value) }}>
              {dayList.map(day => <option key={day} value={day}>{day}</option>)}
            </select>
            <button type="button" className={shared.ghostBtn} disabled={newer === undefined} onClick={() => { if (newer !== undefined) setDate(newer) }}>{t('report.next')}</button>
          </div>
        ) : null}

        {tab === 'report' ? (
          <>
            {days === 'loading' ? <div className={ui.empty}>{t('report.loading')}</div> : null}
            {days === null ? <div className={ui.note}>{t('report.error')}</div> : null}
            {days !== 'loading' && days !== null && !days.available ? <div className={ui.note}>{t('report.unavailable', { reason: days.reason })}</div> : null}
            {days !== 'loading' && days !== null && days.available && days.days.length === 0 ? <div className={ui.empty}>{t('report.none')}</div> : null}
            {report === 'loading' ? <div className={ui.empty}>{t('report.loading')}</div> : null}
            {report === null ? <div className={ui.note}>{t('report.error')}</div> : null}
            {report !== undefined && report !== 'loading' && report !== null && !report.available ? <div className={ui.note}>{t('report.unavailable', { reason: report.reason })}</div> : null}
            {report !== undefined && report !== 'loading' && report !== null && report.available ? <ReportView t={t} report={report.report} /> : null}
          </>
        ) : (
          <>
            {forward === 'loading' ? <div className={ui.empty}>{t('forward.loading')}</div> : null}
            {forward === null ? <div className={ui.note}>{t('report.error')}</div> : null}
            {forward !== undefined && forward !== 'loading' && forward !== null && !forward.available ? <div className={ui.note}>{t('forward.unavailable', { reason: forward.reason })}</div> : null}
            {forward !== undefined && forward !== 'loading' && forward !== null && forward.available ? <ForwardView t={t} data={forward.result} /> : null}
          </>
        )}
      </div>
    </div>
  )
}
