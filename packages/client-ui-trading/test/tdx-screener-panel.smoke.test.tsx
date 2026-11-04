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
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    fetchTdxFormulas: async () => net.formulas as never,
    runTdxSelect: async (formula: string, boards: readonly string[]) => { net.lastSelectArgs = [formula, boards]; return net.select as never },
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

import { TdxScreenerPanel, formatTradeDate } from '../src/client/TdxScreenerPanel.tsx'

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

  it('交易日格式化', () => {
    expect(formatTradeDate('20261103')).toBe('2026-11-03')
    expect(formatTradeDate('')).toBe('')
  })
})
