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

export interface TdxFormulaRunnerLike {
  listFormulas(): Promise<TdxFormulasWire>
  select(request: TdxSelectRequest): Promise<TdxSelectWire>
}

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
  }
}
