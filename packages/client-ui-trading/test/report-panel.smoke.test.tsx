/**
 * ReportPanel 冒烟（2026-11-04）：默认打开最新一天的报告；点股票切图；切到前向检验显示结论与表格；
 * 没配置报告目录时说明原因。
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const net = vi.hoisted(() => ({
  days: null as unknown,
  day: null as unknown,
  dayArgs: [] as string[],
  forward: null as unknown,
  selections: [] as unknown[],
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    fetchReportDays: async () => net.days as never,
    fetchReportDay: async (date: string) => { net.dayArgs.push(date); return net.day as never },
    fetchForwardTest: async () => net.forward as never,
    putHostSelection: async (instrument: unknown) => { net.selections.push(instrument); return true },
  }
})

import { ReportPanel, pct, toSymbol } from '../src/client/ReportPanel.tsx'
import { formatPrice } from '../src/client/ZtUi.tsx'

const t = (key: MarketLocaleKey, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`

const report = {
  date: '2026-11-04', data_date: '20261104', generated_at: '2026-11-04 20:03', behind_days: 0,
  amv: { date: '2026-11-04', state: 'BEAR', since: '2026-10-27', days_in_state: 7, pct_chg: -0.5, bull_at: 4, bear_at: null },
  holdings: [{ code: '600795', name: '国电电力', brick: '第1块红砖', add_verdict: '可加仓' }, { code: '600900', name: '长江电力', error: 'K线不足', close: 0, sells: [] }],
  picks: [{ code: '000530', name: '冰山冷热', reasons: ['金砖共振小4选出', '回调1块绿砖后翻红'] }],
  dropped: [{ code: '603009', name: '北特科技', reason: '近5日S2' }],
  dividend: { total: 50, b1: [] },
  follow_up: { summary: { 5: { count: 3, avg: 1.5, win_rate: 66.7, avg_excess: 0.8 } } },
  rules: { exclude: '近5日 S1/S2/S3' },
}

describe('ReportPanel', () => {
  beforeEach(() => {
    net.days = null
    net.day = null
    net.dayArgs = []
    net.forward = null
    net.selections = []
  })
  afterEach(() => cleanup())

  it('打开最新一天；留下的写理由，点股票切图', async () => {
    net.days = { available: true, days: ['2026-11-04', '2026-11-03'] }
    net.day = { available: true, date: '2026-11-04', report }
    render(<ReportPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('冰山冷热')).not.toBeNull() })
    expect(net.dayArgs).toEqual(['2026-11-04'])
    expect(screen.queryByText('金砖共振小4选出')).not.toBeNull()
    expect(screen.queryByText('回调1块绿砖后翻红')).not.toBeNull()
    expect(screen.queryByText('近5日S2')).not.toBeNull()
    expect(screen.queryByText(/report\.analyzeFailed .*K线不足/)).not.toBeNull()
    expect(screen.queryByText('report.stateBear')).not.toBeNull()
    expect(screen.queryByText(/report\.amvMeta .*"days":7/)).not.toBeNull()
    fireEvent.click(screen.getByText('冰山冷热'))
    expect(net.selections).toEqual([{ market: 'cn', symbol: '000530.SZ', name: '冰山冷热' }])
  })

  it('前向检验：显示结论与入选 / 被剔除 / 随机 / 上证', async () => {
    net.days = { available: true, days: ['2026-11-04'] }
    net.day = { available: true, date: '2026-11-04', report }
    const group = { days: 1, count: 2, avg: 1.2, win_rate: 50, beat_random_rate: 50, excess_vs_random: 0.4, excess_ci: null }
    net.forward = {
      available: true,
      result: {
        horizons: [5], report_days: 2, pending_days: 1, local_through: '20261111',
        summary: { 5: { picks: group, dropped: { ...group, avg: -0.3 }, verdict: '样本不足：已完成 1 个交易日', random_avg: 0.8, bench_avg: 0.2 } },
        by_source: { 我的B1: { 5: group } },
        days: [{ date: '20261104', picks: 2, dropped: 1, universe: { 5: 0.8 }, bench: { 5: 0.2 }, picks_avg: { 5: 1.2 }, dropped_avg: { 5: -0.3 } }],
        notes: ['基准不剔除 ST'],
      },
    }
    render(<ReportPanel t={t} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'report.tabForward' }))
    await waitFor(() => { expect(screen.queryByText('样本不足：已完成 1 个交易日')).not.toBeNull() })
    expect(screen.queryByText('forward.statRandom')).not.toBeNull()
    expect(screen.queryByText('-0.30%')).not.toBeNull()
    expect(screen.queryByText('基准不剔除 ST')).not.toBeNull()
  })

  it('没配置报告目录：写明原因', async () => {
    net.days = { available: false, reason: 'report directory is not configured' }
    render(<ReportPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText(/report\.unavailable/)).not.toBeNull() })
  })

  it('格式化：收益正负号与交易所后缀', () => {
    expect(pct(1.234)).toBe('+1.23%')
    expect(pct(-0.5)).toBe('-0.50%')
    expect(pct(null)).toBe('—')
    expect(toSymbol('600795')).toBe('600795.SH')
    expect(toSymbol('000530')).toBe('000530.SZ')
    expect(toSymbol('920001')).toBe('920001.BJ')
    expect(formatPrice(9.75)).toBe('9.75')
    expect(formatPrice(0.856)).toBe('0.856')
  })
})
