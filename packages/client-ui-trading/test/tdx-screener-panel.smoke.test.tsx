/**
 * TdxScreenerPanel 冒烟（2026-11-04）：通达信没开时明确提示（不冒充「没有选出」）；
 * 选股结果展示与点股票切图；存为分组同名已存在时追加而不是失败。
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const net = vi.hoisted(() => ({
  formulas: null as unknown,
  select: null as unknown,
  selections: [] as unknown[],
  groups: [] as Array<{ id: string; name: string; createdAt: number }>,
  created: [] as string[],
  members: [] as Array<[string, string]>,
  lastSelectArgs: null as unknown,
  review: null as unknown,
  lastReviewArgs: null as unknown,
  reviewCalls: [] as number[],
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    fetchTdxFormulas: async () => net.formulas as never,
    runTdxSelect: async (formula: string, boards: readonly string[]) => { net.lastSelectArgs = [formula, boards]; return net.select as never },
    runZtReview: async (codes: readonly string[], source?: string, date?: string) => { net.reviewCalls.push(codes.length); net.lastReviewArgs = [codes, source, date]; return net.review as never },
    putHostSelection: async (instrument: unknown) => { net.selections.push(instrument); return true },
    createHostWatchlistGroup: async (name: string) => {
      if (net.groups.some(group => group.name === name)) return { ok: false, reason: 'duplicate' }
      net.created.push(name)
      const group = { id: `g${net.groups.length + 1}`, name, createdAt: 1 }
      net.groups.push(group)
      return { ok: true, group }
    },
    fetchHostWatchlistGroups: async () => net.groups,
    addHostWatchlistGroupMember: async (id: string, _market: string, symbol: string) => { net.members.push([id, symbol]); return true },
  }
})

import { TdxScreenerPanel, formatTradeDate, reviewedPicks } from '../src/client/TdxScreenerPanel.tsx'

/** key 直出翻译，参数拼在后面便于断言。 */
const t = (key: MarketLocaleKey, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`

describe('TdxScreenerPanel', () => {
  beforeEach(() => {
    net.formulas = null
    net.select = null
    net.selections = []
    net.groups = []
    net.created = []
    net.members = []
    net.lastSelectArgs = null
    net.review = null
    net.lastReviewArgs = null
    net.reviewCalls = []
  })
  afterEach(() => cleanup())

  it('通达信没开：显示原因与「先打开通达信」，选股按钮不可用', async () => {
    net.formulas = { available: false, reason: '通达信没有运行' }
    render(<TdxScreenerPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect(screen.queryByText(/screener\.unavailable/)).not.toBeNull() })
    expect(screen.queryByText(/screener\.openTdx/)).not.toBeNull()
    expect((screen.getByRole('button', { name: 'screener.run' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('选股：默认主板；展示交易日与只数；点股票切图', async () => {
    net.formulas = { available: true, formulas: [{ code: '我的B1', name: '我的B1' }, { code: '选我的超级B1', name: '我的超级B1选股' }] }
    net.select = { available: true, formula: '我的B1', tradeDate: '20261103', scanned: 5570, totalHits: 34, picks: [{ code: '002181.SZ', name: '粤传媒' }] }
    render(<TdxScreenerPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect((screen.getByRole('button', { name: 'screener.run' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'screener.run' }))
    await waitFor(() => { expect(screen.queryByText('粤传媒')).not.toBeNull() })
    expect(net.lastSelectArgs).toEqual(['我的B1', ['主板']])
    expect(screen.queryByText(/"date":"2026-11-03","scanned":5570,"count":1/)).not.toBeNull()
    fireEvent.click(screen.getByText('粤传媒'))
    expect(net.selections).toEqual([{ market: 'cn', symbol: '002181.SZ', name: '粤传媒' }])
  })

  it('全部 A 股不传板块；没选出时显示「没有选出」而不是错误', async () => {
    net.formulas = { available: true, formulas: [{ code: 'X', name: 'X' }] }
    net.select = { available: true, formula: 'X', tradeDate: '20261103', scanned: 5570, totalHits: 0, picks: [] }
    render(<TdxScreenerPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect((screen.getByRole('button', { name: 'screener.run' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'screener.boardAll' }))
    fireEvent.click(screen.getByRole('button', { name: 'screener.run' }))
    await waitFor(() => { expect(screen.queryByText('screener.empty')).not.toBeNull() })
    expect(net.lastSelectArgs).toEqual(['X', []])
    expect(screen.queryByText('screener.error')).toBeNull()
  })

  it('存为分组：同名分组已存在时追加成员', async () => {
    net.groups = [{ id: 'g9', name: '通达信·我的B1', createdAt: 1 }] // i18n-allow: 分组名是用户数据
    net.formulas = { available: true, formulas: [{ code: '我的B1', name: '我的B1' }] }
    net.select = { available: true, formula: '我的B1', tradeDate: '20261103', scanned: 1, totalHits: 2, picks: [{ code: '002181.SZ', name: '粤传媒' }, { code: '600557.SH', name: '康缘药业' }] }
    render(<TdxScreenerPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect((screen.getByRole('button', { name: 'screener.run' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'screener.run' }))
    await waitFor(() => { expect(screen.queryByText('粤传媒')).not.toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'screener.saveGroup' }))
    await waitFor(() => { expect(screen.queryByText(/screener\.saved/)).not.toBeNull() })
    expect(net.created).toEqual([])
    expect(net.members).toEqual([['g9', '002181.SZ'], ['g9', '600557.SH']])
  })

  it('技能复核：留下的排前面并写理由，剔除的写原因；存分组只存留下的', async () => {
    net.formulas = { available: true, formulas: [{ code: '我的B1', name: '我的B1' }] }
    net.select = { available: true, formula: '我的B1', tradeDate: '20261104', scanned: 3000, totalHits: 2, picks: [{ code: '002181.SZ', name: '粤传媒' }, { code: '600557.SH', name: '康缘药业' }] }
    net.review = {
      available: true, amv: null,
      items: [
        { code: '002181', name: '粤传媒', kept: false, reason: '近5日S1', reasons: [], view: { as_of: '20261104' } },
        { code: '600557', name: '康缘药业', kept: true, reason: '', reasons: ['我的B1选出', '第1块红砖'], view: { as_of: '20261104' } },
      ],
    }
    render(<TdxScreenerPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect((screen.getByRole('button', { name: 'screener.run' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'screener.run' }))
    await waitFor(() => { expect(screen.queryByText('我的B1选出 · 第1块红砖')).not.toBeNull() })
    expect(net.lastReviewArgs).toEqual([['002181.SZ', '600557.SH'], '我的B1', '20261104'])
    expect(screen.queryByText('近5日S1')).not.toBeNull()
    expect(screen.queryByText(/screener\.reviewSummary .*"kept":1,"dropped":1,"pending":0,"asOf":"2026-11-04"/)).not.toBeNull()
    const names = screen.getAllByRole('button').map(button => button.textContent ?? '').filter(text => text.includes('粤传媒') || text.includes('康缘药业'))
    expect(names[0]).toContain('康缘药业')
    fireEvent.click(screen.getByRole('button', { name: /screener\.saveKept/ }))
    await waitFor(() => { expect(screen.queryByText(/screener\.saved/)).not.toBeNull() })
    expect(net.members.map(([, symbol]) => symbol)).toEqual(['600557.SH'])
  })

  it('超过 120 只分批复核；待复核的不算剔除，存分组时保留', async () => {
    const picks = Array.from({ length: 121 }, (_, i) => ({ code: `${600000 + i}.SH`, name: `S${i}` }))
    net.formulas = { available: true, formulas: [{ code: 'X', name: 'X' }] }
    net.select = { available: true, formula: 'X', tradeDate: '20261104', scanned: 3000, totalHits: 121, picks }
    net.review = {
      available: true, amv: null,
      items: picks.map((pick, i) => ({ code: pick.code, name: pick.name, kept: i === 0, status: i === 0 ? 'kept' : 'stale', reason: i === 0 ? '' : '待复核', reasons: [], view: {} })),
    }
    render(<TdxScreenerPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect((screen.getByRole('button', { name: 'screener.run' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'screener.run' }))
    await waitFor(() => { expect(screen.queryByText(/screener\.reviewSummary/)).not.toBeNull() })
    expect(net.reviewCalls).toEqual([120, 1])
    expect(screen.queryByText(/"kept":1,"dropped":0,"pending":120/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /screener\.saveKept/ }))
    await waitFor(() => { expect(screen.queryByText(/screener\.saved/)).not.toBeNull() })
    expect(net.members).toHaveLength(121)
  })

  it('技能不可用：照常列出通达信结果并说明原因', async () => {
    net.formulas = { available: true, formulas: [{ code: 'X', name: 'X' }] }
    net.select = { available: true, formula: 'X', tradeDate: '20261104', scanned: 1, totalHits: 1, picks: [{ code: '002181.SZ', name: '粤传媒' }] }
    net.review = { available: false, reason: 'python not found' }
    render(<TdxScreenerPanel t={t} onClose={() => {}} />)
    await waitFor(() => { expect((screen.getByRole('button', { name: 'screener.run' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'screener.run' }))
    await waitFor(() => { expect(screen.queryByText(/screener\.reviewUnavailable/)).not.toBeNull() })
    expect(screen.queryByText('粤传媒')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'screener.saveGroup' })).not.toBeNull()
  })

  it('reviewedPicks：没复核时原样；复核覆盖不到的排在后面', () => {
    const picks = [{ code: '000001.SZ', name: 'A' }, { code: '600000.SH', name: 'B' }]
    expect(reviewedPicks(picks, null)).toEqual([{ pick: picks[0] }, { pick: picks[1] }])
    const review = { available: true as const, amv: null, items: [{ code: '600000', name: 'B', kept: true, reason: '', reasons: [], view: {} }] }
    expect(reviewedPicks(picks, review).map(row => row.pick.name)).toEqual(['B', 'A'])
  })

  it('交易日格式化', () => {
    expect(formatTradeDate('20261103')).toBe('2026-11-03')
    expect(formatTradeDate('')).toBe('')
  })
})
