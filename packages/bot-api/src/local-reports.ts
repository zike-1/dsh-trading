import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { reportDir } from './local-data-config.ts'

/**
 * zettaranc 每日报告（2026-11-04）：工作台「报告」页签读技能写的 `<reportDir>/data/YYYY-MM-DD.json`。
 *
 * 报告目录写在 DSH home 的 local-data.json（reportDir），环境变量 DSH_TRADING_REPORT_DIR 可覆盖；
 * 没配置时页签提示「未配置」。只读，日期参数只接受 YYYY-MM-DD，不接受任何路径。
 */

export type ReportDaysWire =
  | { available: true; days: string[] }
  | { available: false; reason: string }

export type ReportDayWire =
  | { available: true; date: string; report: Record<string, unknown> }
  | { available: false; reason: string }

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
/** 单份报告 JSON 的上限（正常几十 KB）。 */
const MAX_BYTES = 5 * 1024 * 1024

function dataDir(): string | undefined {
  const dir = reportDir()
  return dir === undefined ? undefined : path.join(dir, 'data')
}

/** 已有报告的日期，最新在前。 */
export async function listReportDays(): Promise<ReportDaysWire> {
  const dir = dataDir()
  if (dir === undefined) return { available: false, reason: 'report directory is not configured (local-data.json reportDir)' }
  try {
    const names = await readdir(dir)
    const days = names
      .filter(name => name.endsWith('.json') && DAY_RE.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5))
      .sort()
      .reverse()
    return { available: true, days }
  } catch (error) {
    return { available: false, reason: `cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 一天的报告数据。日期格式不对抛 `invalid date`（桥转 400）。 */
export async function readReportDay(date: string): Promise<ReportDayWire> {
  if (!DAY_RE.test(date)) throw new Error(`invalid date: ${JSON.stringify(date)}`)
  const dir = dataDir()
  if (dir === undefined) return { available: false, reason: 'report directory is not configured (local-data.json reportDir)' }
  const file = path.join(dir, `${date}.json`)
  try {
    if ((await stat(file)).size > MAX_BYTES) return { available: false, reason: `report too large: ${file}` }
    const report = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (typeof report !== 'object' || report === null || Array.isArray(report)) return { available: false, reason: `not a report: ${file}` }
    return { available: true, date, report: report as Record<string, unknown> }
  } catch (error) {
    return { available: false, reason: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
}
