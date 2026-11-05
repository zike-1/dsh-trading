/**
 * 每日报告读取（2026-11-04）：只读 reportDir/data 下的 YYYY-MM-DD.json，最新在前；
 * 日期参数只接受 YYYY-MM-DD；没配置时 available:false。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TradingBridge, createBridgeHost, dispatchBridgeRequest } from '../src/bridge.ts'

describe('每日报告读取', () => {
  it('列出日期、读一天、拒绝非法日期；没配置时说明原因', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reports-'))
    const previous = process.env.DSH_TRADING_REPORT_DIR
    try {
      const bridge = new TradingBridge(createBridgeHost({ legacy: () => undefined }))
      process.env.DSH_TRADING_REPORT_DIR = join(dir, 'missing')
      expect((await dispatchBridgeRequest(bridge, 'GET', '/reports', new URLSearchParams())).payload).toMatchObject({ available: false })

      await mkdir(join(dir, 'data'), { recursive: true })
      await writeFile(join(dir, 'data', '2026-11-03.json'), JSON.stringify({ date: '2026-11-03', picks: [] }))
      await writeFile(join(dir, 'data', '2026-11-04.json'), JSON.stringify({ date: '2026-11-04', picks: [{ code: '600795' }] }))
      await writeFile(join(dir, 'data', 'notes.json'), '{}')
      process.env.DSH_TRADING_REPORT_DIR = dir

      const days = await dispatchBridgeRequest(bridge, 'GET', '/reports', new URLSearchParams())
      expect(days.payload).toEqual({ available: true, days: ['2026-11-04', '2026-11-03'] })
      const day = await dispatchBridgeRequest(bridge, 'GET', '/reports/day', new URLSearchParams({ date: '2026-11-04' }))
      expect(day.payload).toMatchObject({ available: true, date: '2026-11-04', report: { picks: [{ code: '600795' }] } })
      const absent = await dispatchBridgeRequest(bridge, 'GET', '/reports/day', new URLSearchParams({ date: '2026-11-05' }))
      expect(absent.payload).toMatchObject({ available: false })
      await expect(dispatchBridgeRequest(bridge, 'GET', '/reports/day', new URLSearchParams({ date: '../secret' }))).rejects.toMatchObject({ status: 400 })
    } finally {
      if (previous === undefined) delete process.env.DSH_TRADING_REPORT_DIR
      else process.env.DSH_TRADING_REPORT_DIR = previous
      await rm(dir, { recursive: true, force: true })
    }
  })
})
