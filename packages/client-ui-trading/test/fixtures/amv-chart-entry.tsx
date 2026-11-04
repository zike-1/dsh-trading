/** ui:check 专用组件夹具；不进入产品入口、路由或分发包。数据来自实际本地 0AMV。 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { createIndicatorRegistry, presetDefinitions } from '@dshtrading/indicators'
import type { AmvHistory, IndicatorOutput } from '@dshtrading/indicators'
import { TvChart, type TvBar } from '../../src/client/TvChart.tsx'
import { createChartStateStore } from '../../src/client/chart-state.ts'

const registry = createIndicatorRegistry()
for (const definition of presetDefinitions()) registry.register(definition)
const store = createChartStateStore(registry)

function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const enabled = state.instances.some(instance => instance.id === 'amv-regime')
  const [data, setData] = useState<{ history: AmvHistory; bars: TvBar[] }>()
  const [limit, setLimit] = useState(120)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => { void fetch('/data').then(r => r.json()).then(setData) }, [])
  const bars = useMemo(() => data?.bars.slice(-limit) ?? [], [data, limit])
  const ma = registry.get('ma')!
  const outputs: readonly IndicatorOutput[] = useMemo(() => ma.compute(bars.map(bar => ({ ...bar, openTime: Number(bar.time) * 1000, volume: 0 })), registry.defaultParams(ma)), [bars, ma])
  const overlays = useMemo(() => [{ key: 'ma', title: 'MA', outputs }], [outputs])
  if (!data) return <p>正在只读加载本地数据…</p>
  const day = bars[hover ?? bars.length - 1]?.time
  const date = day === undefined ? '' : new Date(Number(day) * 1000).toISOString().slice(0, 10)
  const interval = data.history.intervals.find(item => item.start <= date && item.end >= date)
  return <main style={{ padding: 20, fontFamily: 'sans-serif', color: '#253044' }}>
    <h2 style={{ margin: '0 0 8px' }}>活跃市值多空区间 · 原生图表组件回归</h2>
    <p>真实本地 0AMV 日线，非个股行情；本页仅作组件门禁，不是新增产品页面或完整终端验收。</p>
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 12 }}>
      <button data-action="toggle" onClick={() => store.togglePreset('amv-regime')} aria-pressed={enabled}>活跃市值多空区间：{enabled ? '开启' : '关闭'}</button>
      <button data-action="range" onClick={() => setLimit(value => value === 120 ? 250 : 120)}>时间范围：{limit} 日</button>
      <span>数据截至 {data.history.lastDate} · 多头为红 / 空头为浅绿</span>
    </div>
    <div style={{ height: 540, border: '1px solid #e6e9ef' }}>
      <TvChart bars={bars} dataKey={`cn:0AMV:1d:${limit}`} intraday={false}
        mainOverlays={overlays} subIndicators={[]}
        readoutIndex={hover} onHoverIndex={setHover} amvHistory={enabled ? data.history : undefined} />
    </div>
    <p>{enabled && interval ? `${interval.state === 'bull' ? '多' : '空'} ${interval.start} ～ ${interval.end}` : '多空背景关闭，原 K 线及均线保留。'}</p>
    <small>{data.history.notice}</small>
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
