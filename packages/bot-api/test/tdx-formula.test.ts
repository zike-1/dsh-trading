/**
 * 通达信选股公式（2026-11-04，离线）：命令行参数校验、JSON 解析、通达信没开时的
 * available:false、串行执行，以及桥路由 /tdx/formulas、/tdx/select。
 */
import { describe, expect, it, vi } from 'vitest'
import { TradingBridge, createBridgeHost, dispatchBridgeRequest } from '../src/bridge.ts'
import { createZtTdxRunner, lastJsonLine, reviewArgs, selectArgs, type ExecLike, type TdxFormulaRunnerLike } from '../src/tdx-formula.ts'

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

describe('复核（按每日报告的规则）', () => {
  it('参数：只收 A 股代码、去重、截断；公式名不能像命令行开关', () => {
    expect(reviewArgs({ codes: ['600795.sh', ' 002541', '600795.SH', 'AAPL', '--x'], source: '我的B1' }))
      .toEqual(['review', '--codes', '600795.SH,002541', '--source', '我的B1'])
    expect(() => reviewArgs({ codes: ['AAPL'] })).toThrow(/invalid codes/)
    expect(reviewArgs({ codes: ['00700.hk', '0700.HK'] })).toEqual(['review', '--codes', '00700.HK'])
    expect(() => reviewArgs({ codes: ['600795'], source: '--help' })).toThrow(/invalid source/)
    expect(reviewArgs({ codes: ['600795.SH'], date: '20261104' })).toEqual(['review', '--codes', '600795.SH', '--date', '20261104'])
    expect(() => reviewArgs({ codes: ['600795.SH'], date: '2026-11-04' })).toThrow(/invalid date/)
    expect(reviewArgs({ codes: Array.from({ length: 200 }, (_, i) => String(600000 + i)) })[2]!.split(',')).toHaveLength(120)
  })

  it('映射留下 / 剔除、理由、视图与活跃市值；技能报错 → available:false', async () => {
    let fail = false
    const exec: ExecLike = async () => fail ? '{"ok": false, "error": "boom"}' : JSON.stringify({
      ok: true, overlay_date: '20261104', amv: { date: '2026-11-04', state: 'BEAR' },
      items: [
        { code: '600795', name: '国电电力', kept: true, reason: '', reasons: ['我的B1选出', 'B1买点 J=-3'], view: { as_of: '20261104', brick: '第1块红砖' } },
        { code: '002541', name: '鸿路钢构', kept: false, reason: '近5日S1', reasons: [], view: null },
      ],
    })
    const runner = createZtTdxRunner({ skillDir: 'C:/skill', exec })
    expect(await runner.review({ codes: ['600795.SH', '002541.SZ'], source: '我的B1' })).toEqual({
      ok: true, available: true, overlayDate: '20261104', amv: { date: '2026-11-04', state: 'BEAR' },
      items: [
        { code: '600795', name: '国电电力', kept: true, reason: '', reasons: ['我的B1选出', 'B1买点 J=-3'], view: { as_of: '20261104', brick: '第1块红砖' }, market: 'A', notes: [], status: 'kept' },
        { code: '002541', name: '鸿路钢构', kept: false, reason: '近5日S1', reasons: [], view: {}, market: 'A', notes: [], status: 'dropped' },
      ],
    })
    fail = true
    expect(await runner.review({ codes: ['600795'] })).toEqual({ ok: true, available: false, reason: 'boom' })
  })
})

describe('桥路由 /tdx/*', () => {
  const runner: TdxFormulaRunnerLike = {
    listFormulas: async () => ({ ok: true, available: true, formulas: [{ code: '我的B1', name: '我的B1' }] }),
    select: async request => ({
      ok: true, available: true, formula: request.formula, tradeDate: '20261103', boards: [...(request.boards ?? [])],
      scanned: 1, totalHits: 1, picks: [{ code: '600795.SH', name: '国电电力' }],
    }),
    review: async request => ({
      ok: true, available: true, overlayDate: '', amv: null,
      items: request.codes.map(code => ({ code: code.slice(0, 6), name: '', kept: true, reason: '', reasons: [request.source ?? ''], view: {}, market: 'A', notes: [], status: 'kept' as const })),
    }),
    forwardTest: async dir => ({ ok: true, available: true, result: { report_days: 1, dir: dir ?? null } }),
  }

  it('GET /zt/forward-test 透传技能结果；技能报错 → available:false', async () => {
    const bridge = new TradingBridge(createBridgeHost({ legacy: () => undefined, tdxFormula: runner }))
    const res = await dispatchBridgeRequest(bridge, 'GET', '/zt/forward-test', new URLSearchParams())
    expect(res.payload).toMatchObject({ available: true, result: { report_days: 1 } })
    const calls: string[][] = []
    const real = createZtTdxRunner({ skillDir: 'C:/skill', exec: async (_f, args) => { calls.push([...args]); return '{"ok": false, "error": "no reports"}' } })
    expect(await real.forwardTest('D:/reports')).toEqual({ ok: true, available: false, reason: 'no reports' })
    expect(calls[0]).toEqual(['-m', 'modules.cli', 'forward-test', '--out', 'D:/reports'])
  })

  it('POST /zt/review 透传、不失效任何 store；代码不合法 → 400', async () => {
    const bridge = new TradingBridge(createBridgeHost({ legacy: () => undefined, tdxFormula: runner }))
    const res = await dispatchBridgeRequest(bridge, 'POST', '/zt/review', new URLSearchParams(), { codes: ['600795.SH'], source: '我的B1' })
    expect(res.payload).toMatchObject({ available: true, items: [{ code: '600795', reasons: ['我的B1'] }] })
    expect('invalidates' in res ? res.invalidates : null).toEqual([])
    const strict = new TradingBridge(createBridgeHost({
      legacy: () => undefined,
      tdxFormula: { ...runner, review: createZtTdxRunner({ skillDir: 'C:/skill', exec: async () => '{}' }).review },
    }))
    await expect(dispatchBridgeRequest(strict, 'POST', '/zt/review', new URLSearchParams(), { codes: ['AAPL'] })).rejects.toMatchObject({ status: 400 })
  })

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
