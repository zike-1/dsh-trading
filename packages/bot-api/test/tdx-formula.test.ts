/**
 * 通达信选股公式（2026-11-04，离线）：命令行参数校验、JSON 解析、通达信没开时的
 * available:false、串行执行，以及桥路由 /tdx/formulas、/tdx/select。
 */
import { describe, expect, it, vi } from 'vitest'
import { TradingBridge, createBridgeHost, dispatchBridgeRequest } from '../src/bridge.ts'
import { createZtTdxRunner, lastJsonLine, selectArgs, type ExecLike, type TdxFormulaRunnerLike } from '../src/tdx-formula.ts'

vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('tdx-formula.test must not hit network')
}))

describe('zettaranc 命令行封装', () => {
  it('只取最后一行 JSON（前面混进的提示行忽略）', () => {
    expect(lastJsonLine('TQ数据接口初始化成功\n{"ok": true, "formulas": []}\r\n')).toEqual({ ok: true, formulas: [] })
    expect(() => lastJsonLine('no json here')).toThrow()
  })

  it('选股参数：板块白名单、日期格式、公式名不能像命令行开关', () => {
    expect(selectArgs({ formula: '我的B1', boards: ['主板', 'bogus'] }))
      .toEqual(['tq-select', '--formula', '我的B1', '--boards', '主板'])
    expect(selectArgs({ formula: '我的搬砖', date: '20261103' }))
      .toEqual(['tq-select', '--formula', '我的搬砖', '--boards', 'all', '--date', '20261103'])
    expect(() => selectArgs({ formula: '--help' })).toThrow(/invalid formula/)
    expect(() => selectArgs({ formula: 'X', date: '2026-11-03' })).toThrow(/invalid date/)
  })

  it('通达信没开 → available:false 带原因；正常 → 映射字段', async () => {
    const calls: string[][] = []
    const exec: ExecLike = async (_file, args) => {
      calls.push([...args])
      if (args.includes('tq-formulas')) return '{"ok": false, "error": "通达信没有运行"}'
      return JSON.stringify({
        ok: true, formula: '我的B1', trade_date: '20261103', boards: ['主板'], scanned: 5570, total_hits: 34,
        picks: [{ code: '002181.SZ', name: '粤传媒' }],
      })
    }
    const runner = createZtTdxRunner({ skillDir: 'C:/skill', exec })
    expect(await runner.listFormulas()).toEqual({ ok: true, available: false, reason: '通达信没有运行' })
    expect(await runner.select({ formula: '我的B1', boards: ['主板'] })).toEqual({
      ok: true, available: true, formula: '我的B1', tradeDate: '20261103', boards: ['主板'], scanned: 5570,
      totalHits: 34, picks: [{ code: '002181.SZ', name: '粤传媒' }],
    })
    expect(calls[0]).toEqual(['-m', 'modules.cli', 'tq-formulas'])
  })

  it('技能 / Python 不在（ENOENT）→ available:false 带原因，不抛裸错误', async () => {
    const exec: ExecLike = async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }
    const runner = createZtTdxRunner({ skillDir: 'C:/missing', exec })
    expect(await runner.select({ formula: 'X' })).toMatchObject({ ok: true, available: false, reason: expect.stringMatching(/not found/) })
  })

  it('一次只跑一个：第二个调用等第一个结束（TQ 接口单连接）', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const exec: ExecLike = async (_file, args) => {
      order.push(`start ${args[2]}`)
      if (args[2] === 'tq-formulas') await new Promise<void>(resolve => { release = resolve })
      order.push(`end ${args[2]}`)
      return '{"ok": true, "formulas": [], "picks": []}'
    }
    const runner = createZtTdxRunner({ skillDir: 'C:/skill', exec })
    const first = runner.listFormulas()
    const second = runner.select({ formula: 'X' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order).toEqual(['start tq-formulas'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['start tq-formulas', 'end tq-formulas', 'start tq-select', 'end tq-select'])
  })
})

describe('桥路由 /tdx/*', () => {
  const runner: TdxFormulaRunnerLike = {
    listFormulas: async () => ({ ok: true, available: true, formulas: [{ code: '我的B1', name: '我的B1' }] }),
    select: async request => ({
      ok: true, available: true, formula: request.formula, tradeDate: '20261103', boards: [...(request.boards ?? [])],
      scanned: 1, totalHits: 1, picks: [{ code: '600795.SH', name: '国电电力' }],
    }),
  }

  it('GET /tdx/formulas 与 POST /tdx/select 透传，选股不失效任何 store', async () => {
    const bridge = new TradingBridge(createBridgeHost({ legacy: () => undefined, tdxFormula: runner }))
    const list = await dispatchBridgeRequest(bridge, 'GET', '/tdx/formulas', new URLSearchParams())
    expect(list.payload).toMatchObject({ available: true, formulas: [{ code: '我的B1' }] })
    const sel = await dispatchBridgeRequest(bridge, 'POST', '/tdx/select', new URLSearchParams(), { formula: '我的B1', boards: ['主板'] })
    expect(sel.payload).toMatchObject({ formula: '我的B1', boards: ['主板'], picks: [{ code: '600795.SH' }] })
    expect('invalidates' in sel ? sel.invalidates : null).toEqual([])
  })

  it('缺公式名 → 400；没挂技能 → TRADING_NOT_IMPLEMENTED', async () => {
    const bridge = new TradingBridge(createBridgeHost({ legacy: () => undefined, tdxFormula: runner }))
    await expect(dispatchBridgeRequest(bridge, 'POST', '/tdx/select', new URLSearchParams(), {})).rejects.toMatchObject({ status: 400 })
    const bare = new TradingBridge(createBridgeHost({ legacy: () => undefined }))
    await expect(bare.tdxFormulas()).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })
})
