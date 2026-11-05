import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { dshHomeDir } from '@dshtrading/dsh-home'

/**
 * 本地 A 股数据目录配置（通达信、指南针）。
 *
 * 优先级：环境变量 > DSH home 下的 `local-data.json` > 未配置。未配置时本地数据功能关闭，
 * 日线照旧走行情接口，活跃市值背景显示「未配置」，不猜任何默认安装路径。
 *
 * local-data.json 示例：
 *   { "tdxDir": "D:/new_tdx64", "zhinanzhenDataDir": "D:/Program Files/WavMain/ANALYSE/Data/ChinaStk" }
 *
 * - tdxDir：通达信安装目录（含 vipdoc、T0002）；
 * - zhinanzhenDataDir：指南针的 ANALYSE/Data/ChinaStk 目录（含 Z_SK/day.vdat，活跃市值 0AMV）；
 * - reportDir：zettaranc 每日报告目录（技能 .env 的 REPORT_OUT_DIR，含 data/YYYY-MM-DD.json），「报告」页签读它。
 */
export interface LocalDataConfig {
  tdxDir?: string
  zhinanzhenDataDir?: string
  reportDir?: string
}

let cache: { file: string; mtimeMs: number; config: LocalDataConfig } | undefined

export function localDataConfigFile(): string {
  return process.env.DSH_TRADING_LOCAL_DATA_CONFIG ?? path.join(dshHomeDir(), 'local-data.json')
}

/** 读 local-data.json（按修改时间缓存）；不存在或格式不对都当作未配置。 */
export function readLocalDataConfig(file: string = localDataConfigFile()): LocalDataConfig {
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return {}
  }
  if (cache?.file === file && cache.mtimeMs === mtimeMs) return cache.config
  let config: LocalDataConfig = {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    config = {
      ...(typeof raw.tdxDir === 'string' && raw.tdxDir.trim() ? { tdxDir: raw.tdxDir.trim() } : {}),
      ...(typeof raw.zhinanzhenDataDir === 'string' && raw.zhinanzhenDataDir.trim() ? { zhinanzhenDataDir: raw.zhinanzhenDataDir.trim() } : {}),
      ...(typeof raw.reportDir === 'string' && raw.reportDir.trim() ? { reportDir: raw.reportDir.trim() } : {}),
    }
  } catch {
    config = {}
  }
  cache = { file, mtimeMs, config }
  return config
}

/** 通达信目录：DSH_TRADING_TDX_DIR > local-data.json tdxDir。 */
export function tdxDir(): string | undefined {
  return process.env.DSH_TRADING_TDX_DIR ?? readLocalDataConfig().tdxDir
}

/** 通达信除权文件 gbbq。 */
export function tdxGbbqFile(): string | undefined {
  const root = tdxDir()
  return process.env.DSH_TRADING_TDX_GBBQ_FILE ?? (root === undefined ? undefined : path.join(root, 'T0002', 'hq_cache', 'gbbq'))
}

/** 指南针活跃市值 0AMV 文件。 */
export function amvFile(): string | undefined {
  const dir = readLocalDataConfig().zhinanzhenDataDir
  return process.env.DSH_TRADING_AMV_FILE ?? (dir === undefined ? undefined : path.join(dir, 'Z_SK', 'day.vdat'))
}

/** zettaranc 每日报告目录：DSH_TRADING_REPORT_DIR > local-data.json reportDir。 */
export function reportDir(): string | undefined {
  return process.env.DSH_TRADING_REPORT_DIR ?? readLocalDataConfig().reportDir
}

/** 活跃市值用的交易日历（上证指数日线）。 */
export function amvCalendarFile(): string | undefined {
  const root = tdxDir()
  return process.env.DSH_TRADING_AMV_CALENDAR_FILE ?? (root === undefined ? undefined : path.join(root, 'vipdoc', 'sh', 'lday', 'sh000001.day'))
}
