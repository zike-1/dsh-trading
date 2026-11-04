/** 已运行 trading-web 的真实界面检查；只操作图表设置，不发送会话或交易。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export async function runAmvLiveCheck({ send, evaluate, click, check }) {
  const out = resolve('outputs/amv-native/live-ui')
  await mkdir(out, { recursive: true })
  const results = []
  const assert = (name, ok, detail = '') => { check(name, ok, detail); results.push({ name, ok, detail }) }
  const waitFor = async expression => {
    for (let i = 0; i < 35; i++) { if (await evaluate(expression) === true) return true; await delay(300) }
    return false
  }
  const button = async text => {
    const rect = await evaluate(`(() => {const el=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.getBoundingClientRect().width>0);if(!el)return null;const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    if (!rect) throw new Error(`Visible button not found: ${text}`)
    await click(rect.x, rect.y)
    await delay(250)
  }
  const snapshot = async name => {
    const clip = await evaluate(`(() => {const el=document.querySelector('[data-dshtrading-quote-stage]');if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.width,innerWidth-r.x),height:Math.min(r.height,innerHeight-r.y),scale:1}})()`)
    const result = await send('Page.captureScreenshot', { format: 'png', ...(clip?.width > 0 && clip?.height > 0 ? { clip } : {}) })
    if (result.result?.data) await writeFile(join(out,name),Buffer.from(result.result.data,'base64'))
  }
  const box = `(() => {const label=[...document.querySelectorAll('label')].find(el=>el.textContent.includes('活跃市值多空区间'));return label?.querySelector('input[type=checkbox]')})()`
  const toggle = async enabled => {
    await button('技术指标')
    const current = await evaluate(`Boolean(${box}?.checked)`)
    if (current !== enabled) {
      const rect = await evaluate(`(() => {const el=${box};if(!el)return null;const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      if (!rect) throw new Error('AMV checkbox not found')
      await click(rect.x,rect.y)
      if (!await waitFor(`Boolean(${box}?.checked) === ${enabled}`)) throw new Error('AMV checkbox update not confirmed')
    }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    if(await evaluate('!!document.querySelector("[role=dialog]")')) {
      const outside=await evaluate(`(() => {const r=document.querySelector('[data-dshtrading-quote-stage]').getBoundingClientRect();return{x:r.x+12,y:r.y+12}})()`)
      await click(outside.x,outside.y)
    }
  }
  try {
    const stage = await waitFor('!!document.querySelector("[data-dshtrading-quote-stage]")')
    assert('L1. 真实终端图表挂载',stage)
    if(!stage) throw new Error('Quote stage not mounted')
    await button('日K')
    await button('技术指标')
    assert('L2. 现有技术指标选择器含活跃市值多空区间',await waitFor(`Boolean(${box})`))
    await snapshot('indicator-picker.png')
    // 收起当前选择器，统一由 toggle 重新进入。
    await button('技术指标')
    await toggle(true)
    assert('L3. 开启后显示真实更新时间',await waitFor(`document.querySelector('[data-dshtrading-quote-stage]')?.textContent.includes('数据截至 2026-10-30') === true`))
    assert('L4. 原生 K 线画布存在',await waitFor('document.querySelectorAll(".dshtrading-tv-chart canvas").length > 0'))
    await snapshot('live-amv-enabled.png')
    await button('周K')
    assert('L5. 周 K 明确停用且不延续旧背景',await waitFor(`document.querySelector('[data-dshtrading-quote-stage]')?.textContent.includes('当前仅支持日 K') === true`))
    await button('月K')
    assert('L6. 月 K 明确停用',await waitFor(`document.querySelector('[data-dshtrading-quote-stage]')?.textContent.includes('当前仅支持日 K') === true`))
    await button('日K')
    assert('L7. 切回日 K 自动恢复',await waitFor(`document.querySelector('[data-dshtrading-quote-stage]')?.textContent.includes('数据截至 2026-10-30') === true`))
    await toggle(false)
    assert('L8. 关闭后更新提示移除且原 K 线仍存在',await waitFor(`!document.querySelector('[data-dshtrading-quote-stage]')?.textContent.includes('数据截至 2026-10-30') && document.querySelectorAll('.dshtrading-tv-chart canvas').length>0`))
    await snapshot('live-amv-disabled.png')
    await toggle(true)
    await send('Page.reload')
    assert('L9. 刷新后继续保持开启',await waitFor(`document.querySelector('[data-dshtrading-quote-stage]')?.textContent.includes('数据截至 2026-10-30') === true`))
    await snapshot('live-amv-enabled.png')
    const code = await evaluate(`document.querySelector('[data-dshtrading-quote-stage]')?.textContent.match(/[0-9]{6}/)?.[0] ?? null`)
    const rows = await evaluate(`[...document.querySelectorAll('[data-dshtrading-market-sidebar] [class*="codeRow"]')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.y>0&&r.y+r.height<innerHeight}).map(el=>{const r=el.getBoundingClientRect();return{text:el.textContent,code:el.textContent.match(/[0-9]{6}/)?.[0],x:r.x+r.width/2,y:r.y+r.height/2}})`)
    const other=rows?.find(row=>row.code&&row.code!==code)
    if(other&&code) {
      await click(other.x,other.y)
      assert('L10. 切换股票后指标仍正确加载',await waitFor(`document.querySelector('[data-dshtrading-quote-stage]')?.textContent.includes(${JSON.stringify(other.code)}) && document.querySelector('[data-dshtrading-quote-stage]')?.textContent.includes('数据截至 2026-10-30')`))
      const original=rows.find(row=>row.code===code)
      if(original)await click(original.x,original.y)
    } else assert('L10. 切换股票检查有可用目标',false,'当前左栏未找到不同的可见股票行，未伪称通过')
  } catch(error) {
    assert('L. 完整交互流程',false,error.message)
    await snapshot('live-failure.png').catch(()=>{})
    const diagnostics=await evaluate(`({buttons:[...document.querySelectorAll('button')].map(el=>el.textContent.trim()).filter(Boolean).slice(0,70),quote:document.querySelector('[data-dshtrading-quote-stage]')?.textContent.slice(0,1000)})`)
    await writeFile(join(out,'diagnostics.json'),JSON.stringify(diagnostics,null,2))
  } finally {
    await writeFile(join(out,'results.json'),JSON.stringify({mode:'live-trading-web',port:8888,testedAt:new Date().toISOString(),results},null,2))
  }
}
