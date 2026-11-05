import { execFile } from 'node:child_process'
import path from 'node:path'

/**
 * 通达信选股公式（2026-11-04）：工作台「选股」面板经桥调用通达信自己的公式引擎。
 *
 * 通达信的 TQ 接口是 Python（通达信安装目录 PYPlugins/sys/tqcenter.py，经 DLL 连到运行中的
 * 客户端），Node 加载不了，所以这里调 zettaranc 技能的命令行：
 * `python -m modules.cli tq-formulas` / `tq-select --formula X --boards 主板`，两者都只输出一行 JSON。
 * 技能那边只用公式列表、批量选股这几个只读接口，不碰 tqcenter 的交易函数。
 *
 * 一次只跑一个（TQ 接口单连接）；通达信没开时命令返回 {ok:false,error}，这里转成
 * available:false + 原因，面板据此提示「先打开通达信」，不把失败画成「没有选出股票」。
 */

export interface TdxFormulaWire {
  /** 通达信里的公式名（调用用这个）。 */
  code: string
  /** 显示名（用户公式多半为空，此时等于 code）。 */
  name: string
}

export type TdxFormulasWire =
  | { ok: true; available: true; formulas: TdxFormulaWire[] }
  | { ok: true; available: false; reason: string }

export interface TdxPickWire {
  /** 600795.SH 形式。 */
  code: string
  name: string
}

export type TdxSelectWire =
  | {
      ok: true
      available: true
      formula: string
      tradeDate: string
      boards: string[] | 'all'
      scanned: number
      totalHits: number
      picks: TdxPickWire[]
    }
  | { ok: true; available: false; reason: string }

export interface TdxSelectRequest {
  formula: string
  /** 板块（主板 / 创业板 / 科创板 / 北交所）；空 = 不过滤。 */
  boards?: readonly string[]
  /** YYYYMMDD；缺省 = 本地最新交易日。 */
  date?: string
}

export interface ZtReviewItemWire {
  /** 6 位代码。 */
  code: string
  name: string
  /** 按每日报告的选股规则：true = 留下，false = 剔除。 */
  kept: boolean
  /** 剔除原因（留下时为空）。 */
  reason: string
  /** 买入理由（剔除时为空）。 */
  reasons: string[]
  /** 技能的单只视图（砖块、B1、卖出信号、黄白线、BOLL 等），字段见技能 StockView。 */
  view: Record<string, unknown>
  /** A / HK；港股只作参考。 */
  market: string
  /** 参考说明（港股：规则按 A 股、未复权、活跃市值是 A 股指标）。 */
  notes: string[]
  /** kept 留下 / dropped 剔除 / stale 待复核（本地数据早于选股日，不参与剔除）。 */
  status: 'kept' | 'dropped' | 'stale'
}

export type ZtReviewWire =
  | { ok: true; available: true; items: ZtReviewItemWire[]; amv: Record<string, unknown> | null; overlayDate: string }
  | { ok: true; available: false; reason: string }

export interface ZtReviewRequest {
  codes: readonly string[]
  /** 选出这些股票的公式名，写进买入理由。 */
  source?: string
  /** 选股日 YYYYMMDD：本地数据早于它的标「待复核」（盘中通达信用当天实时数据选，本地日线还在昨天）。 */
  date?: string
}

export interface TdxFormulaRunnerLike {
  listFormulas(): Promise<TdxFormulasWire>
  select(request: TdxSelectRequest): Promise<TdxSelectWire>
  /** 按每日报告的规则复核几只股票（选股页签的过滤、Z哥诊断卡）；只读。 */
  review(request: ZtReviewRequest): Promise<ZtReviewWire>
  /** 每日报告入选股的前向检验（对比同日随机基准与上证）；只读。reportDir 缺省用技能 .env 的 REPORT_OUT_DIR。 */
  forwardTest(reportDir?: string): Promise<ZtForwardTestWire>
}

/** 前向检验结果原样透传（字段见技能 modules/forward_test.py）。 */
export type ZtForwardTestWire =
  | { ok: true; available: true; result: Record<string, unknown> }
  | { ok: true; available: false; reason: string }

export type ExecLike = (file: string, args: readonly string[], options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }) => Promise<string>

const execPromise: ExecLike = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], { ...options, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(error)
    else resolve(stdout)
  })
})

/** 命令行输出里最后一行 JSON（tqcenter 的提示已在技能侧改到 stderr，这里再兜一层）。 */
export function lastJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{'))
  if (lines.length === 0) throw new Error('zettaranc 命令没有输出 JSON') // i18n-allow: 服务端日志/错误原因
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
}

const BOARD_RE = /^(主板|创业板|科创板|北交所)$/ // i18n-allow: 板块名是技能命令行的参数取值
const DATE_RE = /^\d{8}$/

export function selectArgs(request: TdxSelectRequest): string[] {
  const formula = request.formula.trim()
  if (!formula || formula.startsWith('-')) throw new Error(`invalid formula name: ${JSON.stringify(request.formula)}`)
  const boards = (request.boards ?? []).filter(board => BOARD_RE.test(board))
  const args = ['tq-select', '--formula', formula, '--boards', boards.length > 0 ? boards.join(',') : 'all']
  if (request.date !== undefined && request.date !== '') {
    if (!DATE_RE.test(request.date)) throw new Error(`invalid date: ${JSON.stringify(request.date)}`)
    args.push('--date', request.date)
  }
  return args
}

const CODE_RE = /^(\d{6}(\.(SH|SZ|BJ))?|\d{5}\.HK)$/
/** 复核一次最多几只（技能侧同样截断；每只约半秒）。 */
export const REVIEW_LIMIT = 120

export function reviewArgs(request: ZtReviewRequest): string[] {
  const codes = [...new Set(request.codes.map(code => code.trim().toUpperCase()).filter(code => CODE_RE.test(code)))].slice(0, REVIEW_LIMIT)
  if (codes.length === 0) throw new Error('invalid codes: need A-share codes like 600795.SH or HK codes like 00700.HK')
  const args = ['review', '--codes', codes.join(',')]
  const source = (request.source ?? '').trim()
  if (source !== '') {
    if (source.startsWith('-') || source.length > 60) throw new Error(`invalid source: ${JSON.stringify(request.source)}`)
    args.push('--source', source)
  }
  const date = (request.date ?? '').trim()
  if (date !== '') {
    if (!/^\d{8}$/.test(date)) throw new Error(`invalid date: ${JSON.stringify(request.date)}`)
    args.push('--date', date)
  }
  return args
}

export function createZtTdxRunner(options: {
  /** zettaranc 技能目录（含 .venv）。 */
  skillDir: string
  python?: string
  timeoutMs?: number
  exec?: ExecLike
}): TdxFormulaRunnerLike {
  const python = options.python ?? path.join(options.skillDir, '.venv', 'Scripts', 'python.exe')
  const exec = options.exec ?? execPromise
  const timeout = options.timeoutMs ?? 180_000
  let queue: Promise<unknown> = Promise.resolve()
  const run = (args: readonly string[]): Promise<Record<string, unknown>> => {
    const next = queue.then(async () => lastJsonLine(await exec(python, ['-m', 'modules.cli', ...args], {
      cwd: options.skillDir,
      timeout,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })))
    queue = next.catch(() => undefined)
    return next
  }
  const unavailable = (payload: Record<string, unknown>): { ok: true; available: false; reason: string } =>
    ({ ok: true, available: false, reason: typeof payload.error === 'string' ? payload.error : 'unknown error' })
  /** 技能 / Python 不在（ENOENT）或超时：同样按「不可用 + 原因」回给面板，不抛裸错误。 */
  const runSafe = async (args: readonly string[]): Promise<Record<string, unknown>> => {
    try {
      return await run(args)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ENOENT') return { ok: false, error: `zettaranc skill python not found: ${python}` }
      if ((error as { killed?: unknown }).killed === true) return { ok: false, error: `zettaranc command timed out after ${timeout} ms` }
      throw error
    }
  }

  return {
    async listFormulas() {
      const payload = await runSafe(['tq-formulas'])
      if (payload.ok !== true) return unavailable(payload)
      const items = Array.isArray(payload.formulas) ? payload.formulas as Array<Record<string, unknown>> : []
      return {
        ok: true,
        available: true,
        formulas: items
          .filter(item => typeof item.code === 'string' && item.code !== '')
          .map(item => ({ code: String(item.code), name: typeof item.name === 'string' && item.name ? item.name : String(item.code) })),
      }
    },
    async select(request) {
      const payload = await runSafe(selectArgs(request))
      if (payload.ok !== true) return unavailable(payload)
      const picks = Array.isArray(payload.picks) ? payload.picks as Array<Record<string, unknown>> : []
      return {
        ok: true,
        available: true,
        formula: String(payload.formula ?? request.formula),
        tradeDate: String(payload.trade_date ?? ''),
        boards: Array.isArray(payload.boards) ? payload.boards.map(String) : 'all',
        scanned: Number(payload.scanned ?? 0),
        totalHits: Number(payload.total_hits ?? 0),
        picks: picks.map(pick => ({ code: String(pick.code ?? ''), name: String(pick.name ?? '') })).filter(pick => pick.code !== ''),
      }
    },
    async review(request) {
      const payload = await runSafe(reviewArgs(request))
      if (payload.ok !== true) return unavailable(payload)
      const items = Array.isArray(payload.items) ? payload.items as Array<Record<string, unknown>> : []
      const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
      return {
        ok: true,
        available: true,
        items: items
          .map((item): ZtReviewItemWire => ({
            code: String(item.code ?? ''),
            name: String(item.name ?? ''),
            kept: item.kept === true,
            reason: String(item.reason ?? ''),
            reasons: Array.isArray(item.reasons) ? item.reasons.map(String) : [],
            view: isObject(item.view) ? item.view : {},
            market: typeof item.market === 'string' && item.market !== '' ? item.market : 'A',
            notes: Array.isArray(item.notes) ? item.notes.map(String) : [],
            status: item.status === 'stale' || item.status === 'dropped' || item.status === 'kept'
              ? item.status
              : (item.kept === true ? 'kept' as const : 'dropped' as const),
          }))
          .filter(item => item.code !== ''),
        amv: isObject(payload.amv) ? payload.amv : null,
        overlayDate: String(payload.overlay_date ?? ''),
      }
    },
    async forwardTest(reportDir) {
      const payload = await runSafe(reportDir === undefined || reportDir === '' ? ['forward-test'] : ['forward-test', '--out', reportDir])
      if (payload.ok !== true) return unavailable(payload)
      const { ok: _ok, ...result } = payload
      return { ok: true, available: true, result }
    },
  }
}
