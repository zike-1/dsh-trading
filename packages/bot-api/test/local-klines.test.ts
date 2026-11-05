import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Kline } from '@dshtrading/api'
import { decodeDayFile, forwardAdjust, hasExRightsAfter, isAShareEtf, isAShareStock, joinTail, localDailyKlines, localDailyThrough, missingWeekdays, sinceLastSplit, toKlines } from '../src/local-klines.ts'

function dayRecord(date: number, open: number, high: number, low: number, close: number, shares: number, amount = 0): Buffer {
  const raw = Buffer.alloc(32)
  raw.writeUInt32LE(date, 0)
  raw.writeUInt32LE(open, 4)
  raw.writeUInt32LE(high, 8)
  raw.writeUInt32LE(low, 12)
  raw.writeUInt32LE(close, 16)
  raw.writeFloatLE(amount, 20)
  raw.writeUInt32LE(shares, 24)
  return raw
}

const bar = (date: number, close: number) => ({ date, open: close, high: close, low: close, close, volume: 100 })
const kline = (date: number, close: number): Kline => toKlines([bar(date, close)])[0]!
/** 上海时间的某一刻。 */
const at = (year: number, month: number, day: number, hour: number, minute = 0): number => Date.UTC(year, month - 1, day, hour - 8, minute)

describe('.day 文件', () => {
  it('管理员：价格除以 100、成交量换算成手，与腾讯 K 线口径一致', () => {
    // Given 一条记录：收盘 12.28，成交 44608012 股
    // When 解析
    const bars = decodeDayFile(dayRecord(20261102, 1159, 1241, 1159, 1228, 44608012))
    // Then 单位对
    expect(bars).toEqual([{ date: 20261102, open: 11.59, high: 12.41, low: 11.59, close: 12.28, volume: 446080.12 }])
  })

  it('管理员：高低价矛盾的记录被跳过，长度不对的文件被拒绝', () => {
    // Given 最高价低于收盘价的坏记录、多一个字节的文件
    const bad = dayRecord(20261102, 100, 90, 80, 95, 1)
    // When 解析
    // Then 坏记录没了；坏文件报错
    expect(decodeDayFile(bad)).toEqual([])
    expect(() => decodeDayFile(Buffer.alloc(33))).toThrow('layout')
  })

  it('用户看 ETF 时价格是三位小数，放量日按手存的成交量不会放大 100 倍', () => {
    // Given 588200 两条真实记录：平常日成交量按份存，放量日按手存（成交额 / 成交量 ≈ 均价 × 100）
    const normal = dayRecord(20261102, 788, 800, 780, 795, 409929011, 325_000_000)
    const heavy = dayRecord(20261103, 795, 795, 740, 750, 53206916, 4_100_000_000)
    // When 按 ETF 解析
    const bars = decodeDayFile(Buffer.concat([normal, heavy]), 'etf')
    // Then 价格除以 1000，成交量都换成手
    expect(bars.map(item => item.close)).toEqual([0.795, 0.75])
    expect(bars.map(item => item.volume)).toEqual([4099290.11, 53206916])
  })

  it('管理员：ETF 成交额和成交量两种单位都对不上的记录被跳过', () => {
    // Given 均价落在高低价之外的记录
    // When 按 ETF 解析
    // Then 跳过
    expect(decodeDayFile(dayRecord(20261102, 788, 800, 780, 795, 1000, 5_000_000), 'etf')).toEqual([])
  })

  it('用户看拆分过的 ETF 时只看到拆分之后的历史，不出现假断崖', () => {
    // Given 第三根从 3.539 跳到 1.349（gbbq 没有拆分记录）
    const bars = [bar(20260718, 3.5), bar(20260720, 3.539), bar(20260721, 1.349), bar(20260722, 1.36)]
    // When 截断
    // Then 从拆分日开始；没有跳变时原样
    expect(sinceLastSplit(bars).map(item => item.date)).toEqual([20260721, 20260722])
    expect(sinceLastSplit(bars.slice(0, 2))).toHaveLength(2)
  })
})

describe('前复权', () => {
  it('管理员：10 派 1 元时除权日之前减 0.1，除权日和之后不变', () => {
    // Given 第二根除权
    const bars = [bar(20260101, 10), bar(20260102, 9.9)]
    // When 复权
    const adjusted = forwardAdjust(bars, [{ date: 20260102, cash: 1, rightsPrice: 0, bonus: 0, rights: 0 }])
    // Then 只动除权日之前
    expect(adjusted.map(item => item.close)).toEqual([9.9, 9.9])
  })

  it('管理员：10 送 10 时之前的价格减半，多个事件复合', () => {
    // Given 先送转、后分红
    const bars = [bar(20260101, 20), bar(20260102, 10), bar(20260103, 9.9)]
    const events = [
      { date: 20260102, cash: 0, rightsPrice: 0, bonus: 10, rights: 0 },
      { date: 20260103, cash: 1, rightsPrice: 0, bonus: 0, rights: 0 },
    ]
    // When 复权
    // Then 第一根 (20 - 0) / 2 - 0.1
    expect(forwardAdjust(bars, events).map(item => item.close)).toEqual([9.9, 9.9, 9.9])
  })

  it('管理员：还没到除权日的事件不生效，除权日停牌时落到其后第一根', () => {
    // Given 未来的事件、落在两根之间的事件
    const bars = [bar(20260101, 10), bar(20260105, 9.9)]
    // When 复权
    // Then 未来事件不改价；停牌事件作用于第二根之前
    expect(forwardAdjust(bars, [{ date: 20260201, cash: 1, rightsPrice: 0, bonus: 0, rights: 0 }]).map(item => item.close)).toEqual([10, 9.9])
    expect(forwardAdjust(bars, [{ date: 20260103, cash: 1, rightsPrice: 0, bonus: 0, rights: 0 }]).map(item => item.close)).toEqual([9.9, 9.9])
  })
})

describe('缺几天', () => {
  it('用户盘前打开时不向接口要当天', () => {
    // Given 本地到周一，现在周二 9:00
    // When 算缺口
    // Then 不缺；9:15 之后缺一天
    expect(missingWeekdays(20261102, at(2026, 11, 3, 9, 0))).toBe(0)
    expect(missingWeekdays(20261102, at(2026, 11, 3, 9, 15))).toBe(1)
  })

  it('用户周末打开时不把周六周日算成缺口', () => {
    // Given 本地到周五，现在周日
    // When 算缺口
    // Then 不缺；下周二下午缺两天
    expect(missingWeekdays(20261030, at(2026, 11, 1, 12))).toBe(0)
    expect(missingWeekdays(20261030, at(2026, 11, 3, 15))).toBe(2)
  })
})

describe('接尾巴', () => {
  const local = [kline(20261030, 10), kline(20261102, 11)]

  it('用户看到本地历史接上接口的新 K 线，重叠那根不重复', () => {
    // Given 接口返回重叠的 11-02 和新的 11-03
    // When 拼接
    const joined = joinTail(local, [kline(20261102, 11), kline(20261103, 12)])
    // Then 三根
    expect(joined?.map(item => item.close)).toEqual([10, 11, 12])
  })

  it('用户不会看到除权造成的假跳空：重叠收盘价对不上就放弃拼接', () => {
    // Given 缺口里除权，接口重算后 11-02 变成 5.5
    // When 拼接
    // Then 放弃，交给接口整段
    expect(joinTail(local, [kline(20261102, 5.5), kline(20261103, 5.6)])).toBeNull()
    expect(joinTail(local, [kline(20261103, 12)])).toBeNull()
  })
})

describe('localDailyKlines', () => {
  async function withTdx(run: () => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'tdx-'))
    const previousDir = process.env.DSH_TRADING_TDX_DIR
    const previousGbbq = process.env.DSH_TRADING_TDX_GBBQ_FILE
    process.env.DSH_TRADING_TDX_DIR = dir
    process.env.DSH_TRADING_TDX_GBBQ_FILE = join(dir, 'gbbq')
    try {
      await mkdir(join(dir, 'vipdoc', 'sz', 'lday'), { recursive: true })
      await writeFile(join(dir, 'gbbq'), Buffer.alloc(4))
      await writeFile(join(dir, 'vipdoc', 'sz', 'lday', 'sz000860.day'), Buffer.concat([
        dayRecord(20261030, 1000, 1000, 1000, 1000, 100),
        dayRecord(20261102, 1100, 1100, 1100, 1100, 100),
      ]))
      await run()
    } finally {
      if (previousDir === undefined) delete process.env.DSH_TRADING_TDX_DIR
      else process.env.DSH_TRADING_TDX_DIR = previousDir
      if (previousGbbq === undefined) delete process.env.DSH_TRADING_TDX_GBBQ_FILE
      else process.env.DSH_TRADING_TDX_GBBQ_FILE = previousGbbq
      await rm(dir, { recursive: true, force: true })
    }
  }
  const never = async (): Promise<Kline[]> => { throw new Error('不该请求接口') }

  it('用户在图表角落看到本地日线到哪天；没有本地文件或不是 A 股 = null', async () => {
    await withTdx(async () => {
      expect(await localDailyThrough('000860.SZ')).toBe('2026-11-02')
      expect(await localDailyThrough('000001.SZ')).toBeNull()
      expect(await localDailyThrough('AAPL')).toBeNull()
    })
  })

  it('用户在数据已更新时完全不请求接口', async () => {
    await withTdx(async () => {
      // Given 本地到周一，现在周二盘前
      // When 取日线
      const rows = await localDailyKlines('000860.SZ', 750, never, at(2026, 11, 3, 8))
      // Then 只用本地
      expect(rows?.map(row => row.close)).toEqual([10, 11])
    })
  })

  it('用户盘中只向接口要缺的几根', async () => {
    await withTdx(async () => {
      // Given 现在周二盘中，记下请求根数
      let asked = 0
      const fetchTail = async (_symbol: string, limit: number): Promise<Kline[]> => {
        asked = limit
        return [kline(20261102, 11), kline(20261103, 12)]
      }
      // When 取日线
      const rows = await localDailyKlines('000860.SZ', 750, fetchTail, at(2026, 11, 3, 10))
      // Then 只要了 3 根，并接上当天
      expect(asked).toBe(3)
      expect(rows?.map(row => row.close)).toEqual([10, 11, 12])
    })
  })

  it('用户在接口被拦时仍然看得到本地 K 线', async () => {
    await withTdx(async () => {
      // Given 接口报错（用另一只股票的缓存键之外的时间点）
      // When 取日线
      const rows = await localDailyKlines('000860.SZ', 750, never, at(2026, 11, 10, 10))
      // Then 返回本地部分
      expect(rows?.map(row => row.close)).toEqual([10, 11])
    })
  })

  it('用户在接口被拦时每 30 秒刷新一次，一分钟内不再重复请求接口', async () => {
    await withTdx(async () => {
      // Given 一直失败、记下调用次数的接口
      let calls = 0
      const failing = async (): Promise<Kline[]> => { calls += 1; throw new Error('blocked') }
      // When 盘中连续三次取日线：0 秒、30 秒、70 秒
      const first = await localDailyKlines('000860.SZ', 750, failing, at(2026, 11, 17, 10, 0))
      await localDailyKlines('000860.SZ', 750, failing, at(2026, 11, 17, 10, 0) + 30_000)
      await localDailyKlines('000860.SZ', 750, failing, at(2026, 11, 17, 10, 0) + 70_000)
      // Then 三次都返回本地数据，接口只在第一次和过了一分钟后各打一次
      expect(first?.map(row => row.close)).toEqual([10, 11])
      expect(calls).toBe(2)
    })
  })

  it('用户的通达信很久没更新或没有文件时，整段交给接口', async () => {
    await withTdx(async () => {
      // Given 缺口超过 30 个工作日、本地没有的股票、基金
      // When 取日线
      // Then 都返回 null
      expect(await localDailyKlines('000860.SZ', 750, never, at(2027, 3, 1, 10))).toBeNull()
      expect(await localDailyKlines('600519.SH', 750, never, at(2026, 11, 3, 8))).toBeNull()
      expect(await localDailyKlines('159943.SZ', 750, never, at(2026, 11, 3, 8))).toBeNull()
    })
  })
})

describe('个股判断', () => {
  it('管理员：只有 A 股个股走本地，基金和指数不走', () => {
    // Given 个股、ETF、指数
    // When 判断
    // Then 只有个股
    expect(isAShareStock('sh600519')).toBe(true)
    expect(isAShareStock('sz300750')).toBe(true)
    expect(isAShareStock('bj920985')).toBe(true)
    expect(isAShareStock('sh515590')).toBe(false)
    expect(isAShareStock('sz159943')).toBe(false)
    expect(isAShareStock('sh000001')).toBe(false)
  })

  it('管理员：沪市 51/56/58、深市 159 开头的 ETF 走本地，LOF 和指数不走', () => {
    // Given ETF、LOF、指数
    // When 判断
    // Then 只有 ETF
    expect(isAShareEtf('sh588200')).toBe(true)
    expect(isAShareEtf('sh510300')).toBe(true)
    expect(isAShareEtf('sz159919')).toBe(true)
    expect(isAShareEtf('sz161725')).toBe(false)
    expect(isAShareEtf('sh000001')).toBe(false)
    expect(isAShareEtf('sh600519')).toBe(false)
  })
})


describe('日线拼接只接复权基准一致的尾巴', () => {
  it('收盘差 0.4%（缺口里的小额分红）不再拼接；四舍五入的差可以', () => {
    const local = [kline(20261102, 100)]
    expect(joinTail(local, [kline(20261102, 99.6), kline(20261103, 99.6)])).toBeNull()
    expect(joinTail(local, [kline(20261102, 100.01), kline(20261103, 101)])?.map(row => row.close)).toEqual([100, 101])
  })

  it('本地最后一根之后有除权事件：判定为不能拼', () => {
    expect(hasExRightsAfter([{ date: 20261030 }, { date: 20261104 }], 20261103)).toBe(true)
    expect(hasExRightsAfter([{ date: 20261030 }], 20261103)).toBe(false)
    expect(hasExRightsAfter(null, 20261103)).toBe(false)
  })
})
