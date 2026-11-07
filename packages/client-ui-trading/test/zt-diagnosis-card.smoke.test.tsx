/**
 * Z哥诊断卡与数据新鲜度（2026-11-04）：卡片各行与复制给 Z哥的提问；技能不可用时说明原因；
 * 新鲜度一行区分「全是本地」「之后来自行情接口」「本地没有这只」。
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const net = vi.hoisted(() => ({
  review: null as unknown,
  reviewArgs: [] as unknown[],
  status: null as unknown,
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    runZtReview: async (codes: readonly string[]) => { net.reviewArgs.push(codes); return net.review as never },
    fetchDataStatus: async () => net.status as never,
  }
})

import { DataFreshness, ZtDiagnosisCard, cacheStillFresh, clampPos, clearZtReviewCache, closeNote, diagnosisLines, diagnosisPrompt, freshnessText } from '../src/client/ZtDiagnosisCard.tsx'
import { addWeekdays, hasOhlc, stateRuns } from '../src/client/ZtUi.tsx'

const t = (key: MarketLocaleKey, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`

const item = {
  code: '600795',
  name: '国电电力',
  kept: false,
  reason: '近5日S1',
  reasons: [],
  view: {
    as_of: '20261104', close: 5.1, pct_chg: 1.2, brick: '第1块红砖', b1_today: 'B1', b1_streak: 2, b1_text: 'B1买点 J=-3',
    add_verdict: '可加仓', sells: ['S1'], line: '白线上方', boll_day: '中轨~上轨', boll_week: '下轨~中轨', flyaway: '', macd_veto: false,
  },
}
const amv = { date: '2026-11-04', state: 'BEAR', since: '2026-10-27', days_in_state: 7 }

describe('Z哥诊断卡', () => {
  beforeEach(() => {
    net.review = null
    net.reviewArgs = []
    net.status = null
    clearZtReviewCache()
  })
  afterEach(() => cleanup())

  it('算过的股票切走再切回来不重算；重新计算才再请求', async () => {
    net.review = { available: true, amv, items: [item] }
    const { rerender } = render(<ZtDiagnosisCard t={t} symbol="600795.SH" onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('S1')).not.toBeNull() })
    net.review = { available: true, amv, items: [{ ...item, code: '600900', name: '长江电力' }] }
    rerender(<ZtDiagnosisCard t={t} symbol="600900.SH" onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('长江电力')).not.toBeNull() })
    rerender(<ZtDiagnosisCard t={t} symbol="600795.SH" onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('国电电力')).not.toBeNull() })
    expect(net.reviewArgs).toEqual([['600795.SH'], ['600900.SH']])
    fireEvent.click(screen.getByRole('button', { name: 'zt.refresh' }))
    await waitFor(() => { expect(net.reviewArgs).toHaveLength(3) })
  })

  it('各行：剔除原因、B1 连续天数、卖出信号、活跃市值；缺的写破折号', () => {
    const lines = Object.fromEntries(diagnosisLines(t, item, amv).map(line => [line.label, line.value]))
    expect(lines['zt.label.verdict']).toBe('zt.verdictDropped {"reason":"近5日S1"}')
    expect(lines['zt.label.b1']).toBe('zt.b1Today {"kind":"B1","streak":2} · B1买点 J=-3')
    expect(lines['zt.label.sells']).toBe('S1')
    expect(lines['zt.label.flyaway']).toBe('—')
    expect(lines['zt.label.macd']).toBe('zt.none')
    expect(lines['zt.label.amv']).toContain('"state":"amv.bear","days":7')
  })

  it('复制给 Z哥的提问带上整张卡片', () => {
    const prompt = diagnosisPrompt(t, item, amv)
    expect(prompt.startsWith('zt.prompt ')).toBe(true)
    expect(prompt).toContain('zt.label.sells: S1')
    expect(prompt).toContain('zt.asOf')
  })

  it('打开即按当前标的计算并显示；复制写进剪贴板', async () => {
    net.review = { available: true, amv, items: [item] }
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<ZtDiagnosisCard t={t} symbol="600795.SH" onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('S1')).not.toBeNull() })
    expect(net.reviewArgs).toEqual([['600795.SH']])
    fireEvent.click(screen.getByRole('button', { name: 'zt.copy' }))
    await waitFor(() => { expect(screen.queryByText('zt.copied')).not.toBeNull() })
    expect(writeText).toHaveBeenCalledWith(diagnosisPrompt(t, item, amv))
  })

  it('剪贴板接口被拒时退回传统复制', async () => {
    net.review = { available: true, amv, items: [item] }
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    const execCommand = vi.fn(() => true)
    Object.assign(document, { execCommand })
    render(<ZtDiagnosisCard t={t} symbol="600795.SH" onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('S1')).not.toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'zt.copy' }))
    await waitFor(() => { expect(screen.queryByText('zt.copied')).not.toBeNull() })
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('港股：标出「参考」与局限说明，名称用工作台里的股票名', async () => {
    net.review = { available: true, amv, items: [{ ...item, code: '00700.HK', name: '00700.HK', market: 'HK', notes: ['港股仅作参考'] }] }
    render(<ZtDiagnosisCard t={t} symbol="00700.HK" name="腾讯控股" onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText('腾讯控股')).not.toBeNull() })
    expect(screen.queryByText('zt.hkTag')).not.toBeNull()
    expect(screen.queryByText(/港股仅作参考/)).not.toBeNull()
  })

  it('缓存跨天、或跨过收盘（15:30）就失效', () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
    expect(cacheStillFresh(at(5, 9, 1), at(5, 11, 0))).toBe(true)
    expect(cacheStillFresh(at(5, 9, 1), at(5, 20, 0))).toBe(false)
    expect(cacheStillFresh(at(5, 16, 0), at(5, 20, 0))).toBe(true)
    expect(cacheStillFresh(at(4, 21, 0), at(5, 9, 0))).toBe(false)
  })

  it('价格不是今天的写明哪天收盘；走势按多空分段；工作日推算', () => {
    const now = new Date(2026, 10, 5, 10, 0)
    expect(closeNote(t, '20261104', now)).toBe('zt.closeOf {"date":"11-04"}')
    expect(closeNote(t, '20261105', now)).toBeUndefined()
    expect(stateRuns(['BEAR', 'BEAR', 'BULL', 'BULL', 'BEAR'])).toEqual([
      { bull: false, from: 0, to: 1 }, { bull: true, from: 1, to: 3 }, { bull: false, from: 3, to: 4 },
    ])
    expect(addWeekdays('20261104', 5)).toBe('2026-11-11')
  })

  it('活跃市值：每根都有开高低收才画 K 线', () => {
    const bar = { date: '2026-11-04', open: 1, high: 2, low: 0.5, close: 1.5, state: 'BULL' }
    expect(hasOhlc([bar, { ...bar, date: '2026-11-05' }])).toBe(true)
    expect(hasOhlc([bar, { date: '2026-11-05', close: 1.6 }])).toBe(false)
  })

  it('浮窗拖动时留在屏幕内（至少露出标题栏）', () => {
    const view = { width: 1600, height: 900 }
    expect(clampPos({ x: -50, y: -20 }, 340, view)).toEqual({ x: 0, y: 0 })
    expect(clampPos({ x: 1500, y: 2000 }, 340, view)).toEqual({ x: 1260, y: 860 })
    expect(clampPos({ x: 300, y: 200 }, 340, view)).toEqual({ x: 300, y: 200 })
  })

  it('技能不可用：写明原因，复制按钮不可用', async () => {
    net.review = { available: false, reason: 'python not found' }
    render(<ZtDiagnosisCard t={t} symbol="600795.SH" onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText(/zt\.unavailable/)).not.toBeNull() })
    expect((screen.getByRole('button', { name: 'zt.copy' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('数据新鲜度', () => {
  afterEach(() => cleanup())

  it('三种情况的文字', () => {
    expect(freshnessText(t, null, '2026-11-04')).toBe('fresh.noLocal')
    expect(freshnessText(t, '2026-11-04', '2026-11-04')).toBe('fresh.local {"date":"2026-11-04"}')
    expect(freshnessText(t, '2026-11-03', '2026-11-04')).toBe('fresh.tail {"date":"2026-11-03"}')
  })

  it('显示本地日线与活跃市值的日期；接口失败时不显示', async () => {
    net.status = { localThrough: '2026-11-03', amvThrough: '2026-11-03' }
    render(<DataFreshness t={t} symbol="600795.SH" lastBarDate="2026-11-04" />)
    await waitFor(() => { expect(screen.queryByRole('status')?.getAttribute('title')).toBe('fresh.tail {"date":"2026-11-03"} · fresh.amv {"date":"2026-11-03"}') })
    cleanup()
    net.status = null
    render(<DataFreshness t={t} symbol="600795.SH" lastBarDate={null} />)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
