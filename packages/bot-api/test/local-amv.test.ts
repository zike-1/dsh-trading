import { describe, expect, it } from 'vitest'
import { decodeAmvCalendar, decodeAmvVdat } from '../src/local-amv.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridgeHost, dispatchBridgeRequest, TradingBridge } from '../src/bridge.ts'

/** 独立合成的最小合法二进制样本；不含用户行情。 */
function fixture(): Buffer {
  const raw = Buffer.alloc(1024 + 7048)
  raw.writeUInt16LE(28, 20)
  for (const offset of [64, 116, 1024]) raw.write('Z_SK0AMV', offset, 'ascii')
  raw.writeUInt32LE(20260902, 148)
  raw.writeUInt32LE(1, 152)
  raw[156] = 2
  raw.writeUInt32LE(20260902, 157)
  for (let i = 0; i < 2; i++) {
    const offset = 1056 + i * 28
    raw.writeUInt32LE(20260901 + i, offset)
    for (const [j, value] of [100, 105, 99, 100 + 4 * i, 1000, 100000].entries()) raw.writeFloatLE(value, offset + 4 + 4 * j)
  }
  return raw
}

describe('本地指南针 0AMV 读取', () => {
  it('用户经现有桥读取本地文件，源损坏后立即失效且不回退旧结果', async () => {
    // Given 独立文件与真实桥实例，环境变量只在本例中指向临时目录
    const directory = await mkdtemp(join(tmpdir(), 'amv-bridge-'))
    const previousFile = process.env.DSH_TRADING_AMV_FILE
    const previousCalendar = process.env.DSH_TRADING_AMV_CALENDAR_FILE
    try {
      const source = join(directory, 'day.vdat')
      const calendar = join(directory, 'sh000001.day')
      process.env.DSH_TRADING_AMV_FILE = source
      process.env.DSH_TRADING_AMV_CALENDAR_FILE = calendar
      await writeFile(source, fixture())
      const dates = Buffer.alloc(64)
      dates.writeUInt32LE(20260901, 0); dates.writeUInt32LE(20260902, 32)
      await writeFile(calendar, dates)
      const bridge = new TradingBridge(createBridgeHost({ legacy: () => undefined }))
      // When 请求中即使带文件参数也只读本地配置，然后破坏源文件重读
      const valid = await dispatchBridgeRequest(bridge, 'GET', '/amv-regime', new URLSearchParams({ file: 'ignored.vdat' }))
      await writeFile(source, 'broken')
      const invalid = await dispatchBridgeRequest(bridge, 'GET', '/amv-regime', new URLSearchParams())
      // Then 正常结果带有效边界；损坏后不保留任何旧状态
      expect(valid.status).toBe(200)
      expect(valid.payload).toMatchObject({ available: true, sourceFile: source, firstDate: '2026-09-01', lastDate: '2026-09-02', intervals: [{ start: '2026-09-02', end: '2026-09-02', state: 'bull' }] })
      expect(invalid.payload).toMatchObject({ available: false, points: [], intervals: [] })
    } finally {
      if (previousFile === undefined) delete process.env.DSH_TRADING_AMV_FILE
      else process.env.DSH_TRADING_AMV_FILE = previousFile
      if (previousCalendar === undefined) delete process.env.DSH_TRADING_AMV_CALENDAR_FILE
      else process.env.DSH_TRADING_AMV_CALENDAR_FILE = previousCalendar
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('用户读取分页 VDAT 时获得日期及六个 float 字段，不套用 DAY 格式', () => {
    // Given 有索引与分页的独立样本
    const raw = fixture()
    // When 解码
    const rows = decodeAmvVdat(raw)
    // Then 字段及精确记录数可对照
    expect(rows).toEqual([
      { date: '2026-09-01', open: 100, high: 105, low: 99, close: 100, volume: 1000, amount: 100000 },
      { date: '2026-09-02', open: 100, high: 105, low: 99, close: 104, volume: 1000, amount: 100000 },
    ])
  })
  it('用户遇到截断、布局变化、重复日期或索引不一致时得到拒绝', () => {
    // Given 每种损坏各有独立样本
    const truncated = fixture().subarray(0, 1200)
    const layout = fixture(); layout.writeUInt16LE(32, 20)
    const duplicate = fixture(); duplicate.writeUInt32LE(20260901, 1084)
    const index = fixture(); index.writeUInt32LE(20260903, 157)
    // When 解码损坏样本
    // Then 全部失败关闭
    expect(() => decodeAmvVdat(truncated)).toThrow('Truncated')
    expect(() => decodeAmvVdat(layout)).toThrow('layout')
    expect(() => decodeAmvVdat(duplicate)).toThrow('Duplicate')
    expect(() => decodeAmvVdat(index)).toThrow('index')
  })
  it('用户遇到非法日期、OHLC 或无符号文件时不会得到伪数据', () => {
    // Given 不合法日期和高低关系
    const badDate = fixture(); badDate.writeUInt32LE(20260230, 1056)
    const badOhlc = fixture(); badOhlc.writeFloatLE(90, 1064)
    const absent = fixture(); absent.fill(0, 64, 140)
    // When 尝试提取
    // Then 全部拒绝
    expect(() => decodeAmvVdat(badDate)).toThrow('date')
    expect(() => decodeAmvVdat(badOhlc)).toThrow('OHLC')
    expect(() => decodeAmvVdat(absent)).toThrow('not found')
  })
  it('用户以本地指数日期核查缺日时，日历格式和顺序也必须有效', () => {
    // Given 两个交易日的 DAY 日期字段
    const raw = Buffer.alloc(64)
    raw.writeUInt32LE(20260901, 0); raw.writeUInt32LE(20260902, 32)
    // When 读取真实二进制日历格式
    const dates = decodeAmvCalendar(raw)
    // Then 不把自然日当交易日，重复与截断被拒绝
    expect(dates).toEqual(['2026-09-01', '2026-09-02'])
    expect(() => decodeAmvCalendar(raw.subarray(0, 63))).toThrow('calendar')
    raw.writeUInt32LE(20260901, 32)
    expect(() => decodeAmvCalendar(raw)).toThrow('order')
  })
})
