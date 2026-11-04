import { readFile, stat, writeFile } from 'node:fs/promises'
import type { WatchlistsMap } from '@dshtrading/watchlist'

/**
 * 每日选股报告 → 自选分组（2026-11-03）。
 *
 * zettaranc 技能的 `zt report` 把当天入选的票写进 DSH home 下的 `report-picks.json`；
 * 本模块定时读它，把名单同步进同名分组（默认「今日选股」）。走桥自己的分组方法，
 * 不经 HTTP，所以不需要浏览器登录凭证。
 *
 * 清理规则：不再入选的票移出分组；只有本模块当初新建的行、且不在任何其它分组里时
 * 才删整行，用户自己加的自选永远不删。本模块建过哪些行记在 `report-picks-state.json`。
 */

export interface ReportPicksFile {
  date: string
  group: string
  picks: { symbol: string; name?: string }[]
}

export interface ReportPicksState {
  /** 已同步过的文件修改时间（毫秒），相同就跳过。 */
  appliedMtimeMs?: number
  /** 本模块物化出来的行（600795.SH 形式），只有这些才可能被删整行。 */
  addedRows: string[]
}

/** 桥上用到的分组 / 自选方法（TradingBridge 的子集，便于单测替身）。 */
export interface ReportPicksBridge {
  watchlistGroups(): Promise<{ ok: boolean; groups: { id: string; name: string }[] }>
  createWatchlistGroup(body: unknown): Promise<{ ok: boolean; group?: { id: string; name: string }; reason?: string }>
  watchlistRows(): Promise<{ ok: boolean; watchlists: WatchlistsMap }>
  addWatchlistGroupMember(body: unknown): Promise<{ ok: boolean; added: boolean; materialized: boolean; reason?: string }>
  removeWatchlistGroupMember(id: string, market: string, symbol: string): Promise<{ ok: boolean; removed: boolean }>
  removeWatchlistRow(market: string, symbol: string): Promise<{ ok: boolean; removed: boolean }>
}

export interface ReportPicksResult {
  applied: boolean
  added: string[]
  removed: string[]
  error?: string
}

export const REPORT_PICKS_MARKET = 'cn'
export const REPORT_PICKS_POLL_MS = 60_000

export function parseReportPicks(text: string): ReportPicksFile {
  const raw = JSON.parse(text) as Partial<ReportPicksFile>
  const group = typeof raw.group === 'string' && raw.group.trim() ? raw.group.trim() : '今日选股'
  if (!Array.isArray(raw.picks)) throw new Error('report-picks.json: picks must be an array')
  const picks = raw.picks
    .filter((p): p is { symbol: string; name?: string } => typeof p?.symbol === 'string' && /^\d{6}\.(SH|SZ|BJ)$/.test(p.symbol))
    .map(p => ({ symbol: p.symbol, ...(typeof p.name === 'string' && p.name ? { name: p.name } : {}) }))
  return { date: typeof raw.date === 'string' ? raw.date : '', group, picks }
}

/** 要加入的、要移出的（以及是否连行一起删）、保持不变的。 */
export function planGroupSync(
  desired: readonly string[],
  rows: readonly { symbol: string; groups?: readonly string[] }[],
  groupId: string,
  ours: ReadonlySet<string>,
): { add: string[]; remove: { symbol: string; dropRow: boolean }[]; keep: string[] } {
  const want = [...new Set(desired)]
  const members = new Map(rows.filter(r => r.groups?.includes(groupId)).map(r => [r.symbol, r]))
  const add = want.filter(s => !members.has(s))
  const keep = want.filter(s => members.has(s))
  const remove: { symbol: string; dropRow: boolean }[] = []
  for (const [symbol, row] of members) {
    if (want.includes(symbol)) continue
    const otherGroups = (row.groups ?? []).filter(g => g !== groupId)
    remove.push({ symbol, dropRow: ours.has(symbol) && otherGroups.length === 0 })
  }
  return { add, remove, keep }
}

export async function applyReportPicks(
  bridge: ReportPicksBridge,
  picks: ReportPicksFile,
  state: ReportPicksState,
): Promise<ReportPicksResult> {
  const groups = (await bridge.watchlistGroups()).groups
  let group = groups.find(g => g.name === picks.group)
  if (group === undefined) {
    const created = await bridge.createWatchlistGroup({ name: picks.group })
    if (!created.ok || created.group === undefined) throw new Error(created.reason ?? `create group ${picks.group} failed`)
    group = created.group
  }
  const rows = (await bridge.watchlistRows()).watchlists[REPORT_PICKS_MARKET] ?? []
  const ours = new Set(state.addedRows)
  const names = new Map(picks.picks.map(p => [p.symbol, p.name]))
  const plan = planGroupSync(picks.picks.map(p => p.symbol), rows, group.id, ours)
  const result: ReportPicksResult = { applied: true, added: [], removed: [] }
  for (const symbol of plan.add) {
    const name = names.get(symbol)
    const res = await bridge.addWatchlistGroupMember({ id: group.id, market: REPORT_PICKS_MARKET, symbol, ...(name ? { name } : {}) })
    if (!res.ok) throw new Error(res.reason ?? `add ${symbol} failed`)
    if (res.materialized) ours.add(symbol)
    result.added.push(symbol)
  }
  for (const { symbol, dropRow } of plan.remove) {
    await bridge.removeWatchlistGroupMember(group.id, REPORT_PICKS_MARKET, symbol)
    if (dropRow) {
      await bridge.removeWatchlistRow(REPORT_PICKS_MARKET, symbol)
      ours.delete(symbol)
    }
    result.removed.push(symbol)
  }
  state.addedRows = [...ours].sort()
  return result
}

export interface ReportPicksWatcherOptions {
  bridge: ReportPicksBridge
  file: string
  stateFile: string
  /** 同步改动了自选时调用（发 watchlists 失效事件，让打开的页面刷新）。 */
  onChanged?: () => void
  log?: (message: string) => void
  pollMs?: number
}

async function readState(file: string): Promise<ReportPicksState> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<ReportPicksState>
    return {
      ...(typeof raw.appliedMtimeMs === 'number' ? { appliedMtimeMs: raw.appliedMtimeMs } : {}),
      addedRows: Array.isArray(raw.addedRows) ? raw.addedRows.filter((s): s is string => typeof s === 'string') : [],
    }
  } catch {
    return { addedRows: [] }
  }
}

/** 检查一次：文件比上次同步的新才应用。文件不存在是正常情况（还没生成过报告）。 */
export async function checkReportPicks(options: ReportPicksWatcherOptions): Promise<ReportPicksResult | undefined> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(options.file)).mtimeMs
  } catch {
    return undefined
  }
  const state = await readState(options.stateFile)
  if (state.appliedMtimeMs === mtimeMs) return undefined
  try {
    const picks = parseReportPicks(await readFile(options.file, 'utf8'))
    const result = await applyReportPicks(options.bridge, picks, state)
    state.appliedMtimeMs = mtimeMs
    await writeFile(options.stateFile, JSON.stringify(state, null, 1), 'utf8')
    if (result.added.length > 0 || result.removed.length > 0) options.onChanged?.()
    options.log?.(`[dsh-trading/report-picks] ${picks.date} ${picks.group}: +${result.added.length} -${result.removed.length}`)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.log?.(`[dsh-trading/report-picks] sync failed: ${message}`)
    return { applied: false, added: [], removed: [], error: message }
  }
}

/** 启动时查一次，之后每分钟查一次；返回停止函数。 */
export function startReportPicksWatcher(options: ReportPicksWatcherOptions): () => void {
  let running = false
  const tick = (): void => {
    if (running) return
    running = true
    void checkReportPicks(options).finally(() => { running = false })
  }
  tick()
  const timer = setInterval(tick, options.pollMs ?? REPORT_PICKS_POLL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
