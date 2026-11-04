/**
 * 每日选股报告 → 自选分组（2026-11-03，离线）：用真实 TradingBridge + 内存 store，
 * 验证建组、加入（物化行）、移出时只删报告自己建的行、文件没变不重复同步。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TradingBridge, createBridgeHost } from '../src/bridge.ts'
import { checkReportPicks, parseReportPicks, planGroupSync } from '../src/report-picks.ts'

vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('report-picks.test must not hit network')
}))

const makeBridge = () => new TradingBridge(createBridgeHost({ legacy: () => undefined }))

async function tempFiles() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'report-picks-'))
  return { file: path.join(dir, 'report-picks.json'), stateFile: path.join(dir, 'report-picks-state.json') }
}

const writePicks = (file: string, date: string, symbols: string[]) =>
  writeFile(file, JSON.stringify({ date, group: '今日选股', picks: symbols.map(symbol => ({ symbol, name: `名${symbol}` })) }), 'utf8')

async function groupMembers(bridge: TradingBridge, name: string): Promise<string[]> {
  const group = (await bridge.watchlistGroups()).groups.find(g => g.name === name)
  if (group === undefined) return []
  const rows = (await bridge.watchlistRows()).watchlists.cn ?? []
  return rows.filter(r => r.groups?.includes(group.id)).map(r => r.symbol).sort()
}

describe('report picks → watchlist group', () => {
  it('解析只收 600795.SH 形式的代码，组名缺省为今日选股', () => {
    const parsed = parseReportPicks(JSON.stringify({ date: '2026-11-03', picks: [{ symbol: '002541.SZ', name: '鸿路钢构' }, { symbol: '002541' }, {}] }))
    expect(parsed).toEqual({ date: '2026-11-03', group: '今日选股', picks: [{ symbol: '002541.SZ', name: '鸿路钢构' }] })
  })

  it('移出时只删报告自己建的、且不在其它分组的行', () => {
    const rows = [
      { symbol: '600001.SH', groups: ['pick'] },
      { symbol: '600002.SH', groups: ['pick', 'hold'] },
      { symbol: '600003.SH', groups: ['pick'] },
      { symbol: '600004.SH', groups: ['pick'] },
      { symbol: '600036.SH' },
    ]
    expect(planGroupSync(['600004.SH', '002541.SZ'], rows, 'pick', new Set(['600001.SH', '600002.SH']))).toEqual({
      add: ['002541.SZ'],
      keep: ['600004.SH'],
      remove: [
        { symbol: '600001.SH', dropRow: true },
        { symbol: '600002.SH', dropRow: false },
        { symbol: '600003.SH', dropRow: false },
      ],
    })
  })

  it('建组并加入；文件没变不重复；次日名单变化时移出旧票并删掉报告建的行', async () => {
    const bridge = makeBridge()
    const { file, stateFile } = await tempFiles()
    const changed = vi.fn()
    const options = { bridge, file, stateFile, onChanged: changed }

    expect(await checkReportPicks(options)).toBeUndefined() // 还没有报告文件

    // 用户自己加的一只，后来也入选
    await bridge.addWatchlistRow({ market: 'cn', symbol: '600036.SH', name: '招商银行' })
    await writePicks(file, '2026-11-03', ['002541.SZ', '600036.SH'])
    const first = await checkReportPicks(options)
    expect(first).toMatchObject({ applied: true, added: ['002541.SZ', '600036.SH'], removed: [] })
    expect(await groupMembers(bridge, '今日选股')).toEqual(['002541.SZ', '600036.SH'])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(stateFile, 'utf8')).addedRows).toEqual(['002541.SZ'])

    expect(await checkReportPicks(options)).toBeUndefined() // mtime 没变

    await new Promise(resolve => setTimeout(resolve, 20))
    await writePicks(file, '2026-11-04', ['600558.SH'])
    const second = await checkReportPicks(options)
    expect(second).toMatchObject({ applied: true, added: ['600558.SH'] })
    expect(second?.removed.slice().sort()).toEqual(['002541.SZ', '600036.SH'])
    expect(await groupMembers(bridge, '今日选股')).toEqual(['600558.SH'])
    const symbols = ((await bridge.watchlistRows()).watchlists.cn ?? []).map(r => r.symbol)
    expect(symbols).not.toContain('002541.SZ') // 报告建的行删掉
    expect(symbols).toContain('600036.SH') // 用户自己的行保留
  })

  it('文件坏了返回错误、不改状态，修好后照常同步', async () => {
    const bridge = makeBridge()
    const { file, stateFile } = await tempFiles()
    await writeFile(file, '{bad json', 'utf8')
    const bad = await checkReportPicks({ bridge, file, stateFile })
    expect(bad?.applied).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    await writePicks(file, '2026-11-03', ['002541.SZ'])
    expect(await checkReportPicks({ bridge, file, stateFile })).toMatchObject({ applied: true, added: ['002541.SZ'] })
  })
})
