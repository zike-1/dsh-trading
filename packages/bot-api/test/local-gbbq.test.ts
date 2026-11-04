import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBridgeHost, dispatchBridgeRequest, TradingBridge } from '../src/bridge.ts'
import { decodeGbbqFloats, gbbqSymbol } from '../src/local-gbbq.ts'

/** 本机 gbbq 里 601985 的三条原始记录，期望值由 pytdx 解出。 */
const RECORDS = [
  'QUGX9OKuAtSylx+LoYs4lg0VpkIwRCekSV5Y5kk=',
  'QUGX9OKuAtSODaIINze3M3Dw0SX2DGF/SUSC5kk=',
  'QUGX9OKuAtTSeAUBQ8nM/K4klrEc3JCDSQIT+0k=',
]

function gbbqFile(records: readonly string[]): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(records.length, 0)
  return Buffer.concat([header, ...records.map(record => Buffer.from(record, 'base64'))])
}

describe('本地通达信 gbbq 读取', () => {
  it('管理员：解出的流通股本变动与 pytdx 逐值一致', () => {
    // Given 三条真实记录
    // When 解密
    const events = decodeGbbqFloats(gbbqFile(RECORDS)).get('sh601985')
    // Then 日期和变动前后的流通盘都对
    expect(events).toEqual([
      { date: 20230331, before: 1886070.375, after: 1886987.75 },
      { date: 20230627, before: 1886987.75, after: 1888328.5 },
      { date: 20250110, before: 1888328.5, after: 1888328.5 },
    ])
  })

  it('管理员：同一只股票的记录按日期升序，文件顺序不影响结果', () => {
    // Given 倒序写入
    // When 解密
    const events = decodeGbbqFloats(gbbqFile([...RECORDS].reverse())).get('sh601985')
    // Then 仍然升序
    expect(events?.map(event => event.date)).toEqual([20230331, 20230627, 20250110])
  })

  it('管理员：长度对不上的文件被拒绝，不猜字段', () => {
    // Given 多一个字节、太短两种文件
    // When 解密
    // Then 都报错
    expect(() => decodeGbbqFloats(Buffer.concat([gbbqFile(RECORDS), Buffer.alloc(1)]))).toThrow('layout')
    expect(() => decodeGbbqFloats(Buffer.alloc(2))).toThrow('truncated')
  })

  it('管理员：带后缀和不带后缀的代码都能对上市场', () => {
    // Given 各种写法
    // When 转换
    // Then 市场正确，认不出的返回 null
    expect(gbbqSymbol('601985.SH')).toBe('sh601985')
    expect(gbbqSymbol('000860.sz')).toBe('sz000860')
    expect(gbbqSymbol('300750')).toBe('sz300750')
    expect(gbbqSymbol('920985')).toBe('bj920985')
    expect(gbbqSymbol('AAPL')).toBeNull()
  })

  it('用户请求股本历史时只读本地配置的文件，文件坏了明确报不可用', async () => {
    // Given 指向临时文件的配置
    const dir = await mkdtemp(join(tmpdir(), 'gbbq-'))
    const source = join(dir, 'gbbq')
    const previous = process.env.DSH_TRADING_TDX_GBBQ_FILE
    process.env.DSH_TRADING_TDX_GBBQ_FILE = source
    try {
      await writeFile(source, gbbqFile(RECORDS))
      const bridge = new TradingBridge(createBridgeHost({ legacy: () => undefined }))
      // When 请求里带文件参数，然后破坏源文件重读
      const valid = await dispatchBridgeRequest(bridge, 'GET', '/float-history', new URLSearchParams({ symbol: '601985.SH', file: 'ignored' }))
      await writeFile(source, 'broken')
      const invalid = await dispatchBridgeRequest(bridge, 'GET', '/float-history', new URLSearchParams({ symbol: '601985.SH' }))
      // Then 正常时带事件，损坏后不保留旧数据
      expect(valid.status).toBe(200)
      expect(valid.payload).toMatchObject({ available: true, sourceFile: source })
      expect((valid.payload as { events: unknown[] }).events).toHaveLength(3)
      expect(invalid.payload).toMatchObject({ available: false, events: [] })
    } finally {
      if (previous === undefined) delete process.env.DSH_TRADING_TDX_GBBQ_FILE
      else process.env.DSH_TRADING_TDX_GBBQ_FILE = previous
      await rm(dir, { recursive: true, force: true })
    }
  })
})
