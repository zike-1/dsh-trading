/**
 * 通达信选股面板（右缘会话列容器的功能页签，2026-11-04）。
 *
 * 与宏观/预测市场同款模式：SessionRail 竖条按钮激活时原位覆盖对话列，与其余页签互斥；
 * 状态由 SessionRail 写 body[data-dshtrading-screener-open]，shell-pad.css 规则 17 隐去
 * 对话列内容；本组件是 fixed 面板，定位与宽度吃 frame 轨道变量（tdx-screener-panel.module.css）。
 *
 * 公式在通达信「公式管理器」里维护；面板只列出通达信里的自定义条件选股公式，按名调用
 * 通达信自己的公式引擎（桥 /tdx/*，经 zettaranc 技能命令行），所以结果与通达信一键选股一致，
 * 不需要把公式移植过来。通达信没开时明确提示，不把失败画成「没有选出股票」。
 *
 * - 点股票名：putHostSelection 切中栏图表（与左栏点击同源，SSE 'selection' 联动）；
 * - 存为分组：写进「通达信·公式名」分组（已存在就追加），不碰报告管理的「今日选股」。
 */
import { useEffect, useState } from 'react'
import {
  addHostWatchlistGroupMember,
  createHostWatchlistGroup,
  fetchHostWatchlistGroups,
  fetchTdxFormulas,
  putHostSelection,
  runTdxSelect,
  type ClientTdxFormulas,
  type ClientTdxSelect,
} from './api.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './tdx-screener-panel.module.css'

export type TdxScreenerTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface TdxScreenerPanelProps {
  t: TdxScreenerTranslate
  onClose(): void
}

/** 板块取值是技能命令行参数（与 tdx_local_client 板块名一致）。 */
const MAIN_BOARD: readonly string[] = ['主板'] // i18n-allow: 命令行参数取值，非 UI 文案
const GROUP_PREFIX = '通达信·' // i18n-allow: 分组名前缀写进用户数据，固定中文

/** 20261103 → 2026-11-03。 */
export function formatTradeDate(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value
}

/** 存为分组：同名分组已存在就追加成员，不报重复。返回分组名；失败 = null。 */
export async function savePicksToGroup(formula: string, picks: readonly { code: string; name: string }[]): Promise<string | null> {
  const name = `${GROUP_PREFIX}${formula}`
  const created = await createHostWatchlistGroup(name)
  let id = created.ok ? created.group.id : undefined
  if (!created.ok && created.reason === 'duplicate') {
    const groups = await fetchHostWatchlistGroups()
    id = groups?.find(group => group.name === name)?.id
  }
  if (id === undefined) return null
  for (const pick of picks) {
    const ok = await addHostWatchlistGroupMember(id, 'cn', pick.code, pick.name || undefined)
    if (!ok) return null
  }
  return name
}

export function TdxScreenerPanel({ t, onClose }: TdxScreenerPanelProps) {
  const [formulas, setFormulas] = useState<ClientTdxFormulas | null | 'loading'>('loading')
  const [formula, setFormula] = useState('')
  const [mainOnly, setMainOnly] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ClientTdxSelect | null | undefined>(undefined)
  const [saveNote, setSaveNote] = useState('')

  const loadFormulas = async (): Promise<void> => {
    setFormulas('loading')
    const list = await fetchTdxFormulas()
    setFormulas(list)
    if (list !== null && list.available && list.formulas.length > 0) {
      setFormula(current => (list.formulas.some(item => item.code === current) ? current : list.formulas[0]!.code))
    }
  }

  useEffect(() => { void loadFormulas() }, [])

  const run = async (): Promise<void> => {
    if (formula === '' || running) return
    setRunning(true)
    setSaveNote('')
    setResult(undefined)
    setResult(await runTdxSelect(formula, mainOnly ? MAIN_BOARD : []))
    setRunning(false)
  }

  const save = async (): Promise<void> => {
    if (result === null || result === undefined || !result.available || result.picks.length === 0) return
    const name = await savePicksToGroup(result.formula, result.picks)
    setSaveNote(name === null ? t('screener.saveFailed') : t('screener.saved', { name, count: result.picks.length }))
  }

  const unavailableReason = formulas !== 'loading' && formulas !== null && !formulas.available ? formulas.reason : null

  return (
    <div className={css.panel} data-dshtrading-screener-panel="" role="panel" aria-label={t('stage.screener')}>
      <header className={css.head}>
        <strong className={css.title}>{t('stage.screener')}</strong>
        <span className={css.spacer} />
        <button type="button" className={css.closeBtn} aria-label={t('flash.close')} title={t('flash.close')} onClick={onClose}>×</button>
      </header>
      <div className={css.body}>
        <p className={css.hint}>{t('screener.hint')}</p>
        {formulas === 'loading' ? <p className={css.empty}>{t('screener.loading')}</p> : null}
        {formulas === null ? <p className={css.error}>{t('screener.error')}</p> : null}
        {unavailableReason !== null ? (
          <p className={css.error}>{t('screener.unavailable', { reason: unavailableReason })} {t('screener.openTdx')}</p>
        ) : null}
        {formulas !== 'loading' && formulas !== null && formulas.available && formulas.formulas.length === 0 ? (
          <p className={css.empty}>{t('screener.noFormulas')}</p>
        ) : null}
        <div className={css.controls}>
          <label className={css.field}>
            <span className={css.label}>{t('screener.formula')}</span>
            <select
              className={css.select}
              value={formula}
              disabled={formulas === 'loading' || formulas === null || !formulas.available || running}
              onChange={(event) => { setFormula(event.target.value) }}
            >
              {formulas !== 'loading' && formulas !== null && formulas.available
                ? formulas.formulas.map(item => (
                    <option key={item.code} value={item.code}>{item.name === item.code ? item.code : `${item.code} · ${item.name}`}</option>
                  ))
                : null}
            </select>
          </label>
          <button type="button" className={css.ghostBtn} onClick={() => { void loadFormulas() }} disabled={running}>
            {t('screener.refresh')}
          </button>
        </div>
        <div className={css.controls}>
          <div className={css.seg} role="group" aria-label={t('screener.boardAll')}>
            <button type="button" className={css.segBtn} aria-pressed={mainOnly} onClick={() => { setMainOnly(true) }}>{t('screener.boardMain')}</button>
            <button type="button" className={css.segBtn} aria-pressed={!mainOnly} onClick={() => { setMainOnly(false) }}>{t('screener.boardAll')}</button>
          </div>
          <span className={css.spacer} />
          <button type="button" className={css.primaryBtn} disabled={formula === '' || running} onClick={() => { void run() }}>
            {t('screener.run')}
          </button>
        </div>
        {running ? <p className={css.empty}>{t('screener.running')}</p> : null}
        {result === null ? <p className={css.error}>{t('screener.error')}</p> : null}
        {result !== null && result !== undefined && !result.available ? (
          <p className={css.error}>{t('screener.unavailable', { reason: result.reason })} {t('screener.openTdx')}</p>
        ) : null}
        {result !== null && result !== undefined && result.available ? (
          <>
            <div className={css.summaryRow}>
              <span className={css.summary}>
                {t('screener.summary', { date: formatTradeDate(result.tradeDate), scanned: result.scanned, count: result.picks.length })}
              </span>
              <span className={css.spacer} />
              {result.picks.length > 0 ? (
                <button type="button" className={css.ghostBtn} onClick={() => { void save() }}>{t('screener.saveGroup')}</button>
              ) : null}
            </div>
            {saveNote !== '' ? <p className={css.note}>{saveNote}</p> : null}
            {result.picks.length === 0 ? <p className={css.empty}>{t('screener.empty')}</p> : (
              <>
                <p className={css.hint}>{t('screener.openHint')}</p>
                <ul className={css.list}>
                  {result.picks.map(pick => (
                    <li key={pick.code}>
                      <button
                        type="button"
                        className={css.row}
                        onClick={() => { void putHostSelection({ market: 'cn', symbol: pick.code, ...(pick.name ? { name: pick.name } : {}) }) }}
                      >
                        <span className={css.name}>{pick.name || pick.code}</span>
                        <span className={css.code}>{pick.code}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
