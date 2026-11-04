/** ui:check --amv-chart：真实 TvChart + 本地只读数据 + 无窗口 Chrome 回归门禁。 */
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'tsdown'
import { readLocalAmv, decodeAmvVdat } from '../packages/bot-api/src/local-amv.ts'

export async function runAmvChartCheck() {
  const out = resolve('outputs/amv-native/chart-gate')
  await mkdir(out, { recursive: true })
  const history = await readLocalAmv()
  if (!history.available) throw new Error(history.notice)
  const rows = decodeAmvVdat(await readFile(history.sourceFile))
  const data = JSON.stringify({ history, bars: rows.map(row => ({ time: Date.parse(`${row.date}T00:00:00Z`) / 1000, open: row.open, high: row.high, low: row.low, close: row.close })) })
  await build({ config: false, entry: ['packages/client-ui-trading/test/fixtures/amv-chart-entry.tsx'], outDir: out,
    format: 'iife', platform: 'browser', dts: false, clean: false, minify: true,
    deps: { alwaysBundle: () => true }, define: { 'process.env.NODE_ENV': '"production"' },
    inputOptions: { transform: { jsx: { runtime: 'automatic' } } },
  })
  const js = await readFile(join(out, 'amv-chart-entry.iife.js'))
  const server = createServer((request, response) => {
    if (request.url === '/data') { response.setHeader('content-type', 'application/json'); response.end(data) }
    else if (request.url === '/app.js') { response.setHeader('content-type', 'text/javascript'); response.end(js) }
    else { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<!doctype html><html><meta charset="utf-8"><title>AMV 组件回归门禁</title><div id="root"></div><script src="/app.js"></script></html>') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  const profile = await mkdtemp(join(tmpdir(), 'amv-chart-gate-'))
  const chromeBin = process.env.DSH_UI_CHROME ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  const chrome = spawn(chromeBin, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1480,860', `http://127.0.0.1:${port}/`], { stdio: ['ignore', 'ignore', 'pipe'], detached: true, windowsHide: true })
  const results = []
  let socket
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
  try {
    const wsUrl = await new Promise((done, fail) => {
      let output = ''
      const timer = setTimeout(() => fail(new Error('Headless Chrome startup timed out')), 20000)
      chrome.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); done(match[1]) } })
      chrome.on('error', error => { clearTimeout(timer); fail(error) })
    })
    const debugPort = new URL(wsUrl).port
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
    const page = pages.find(page => page.type === 'page')
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
    let id = 0
    const pending = new Map()
    const errors = []
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text) }
    const send = (method, params = {}) => new Promise((done, fail) => {
      const current = ++id
      const timer = setTimeout(() => { pending.delete(current); fail(new Error(`CDP timeout: ${method}`)) }, 10000)
      pending.set(current, message => { clearTimeout(timer); message.error ? fail(new Error(message.error.message)) : done(message.result) })
      socket.send(JSON.stringify({ id: current, method, params }))
    })
    const evaluate = async expression => {
      const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text)
      return value.result.value
    }
    await send('Runtime.enable')
    await send('Page.enable')
    const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    for (let attempts = 0; attempts < 100; attempts++) {
      if (await evaluate('!!document.querySelector(".dshtrading-tv-chart canvas")')) break
      await new Promise(done => setTimeout(done, 100))
    }
    await settle()
    check('真实 TvChart 已挂载', await evaluate('document.querySelectorAll(".dshtrading-tv-chart canvas").length > 0'))
    const press = async action => {
      const rect = await evaluate(`(() => {const r=document.querySelector('[data-action="${action}"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...rect, button: 'left', clickCount: 1 })
      await settle()
    }
    const pixels = () => evaluate(`(() => {
      let red=0,green=0;const edges=[];
      for(const canvas of document.querySelectorAll('.dshtrading-tv-chart canvas')) {
        if(canvas.width<500||canvas.height<200)continue;
        const ctx=canvas.getContext('2d');const y=Math.round(canvas.height*0.15);const row=ctx.getImageData(0,y,canvas.width,1).data;let previous='';
        for(let x=0;x<canvas.width;x++){const i=x*4,r=row[i],g=row[i+1],b=row[i+2];const color=r>210&&g>170&&b>170&&r-g>5&&r-b>5?'r':g>210&&r>170&&b>170&&g-r>5&&g-b>2?'g':'';if(color==='r')red++;if(color==='g')green++;if(color!==previous){edges.push(x+':'+color);previous=color}}
      }return{red,green,edges:edges.join(',')}
    })()`)
    const off = await pixels()
    check('默认关闭', !(await evaluate('document.querySelector("[data-action=toggle]").getAttribute("aria-pressed")==="true"')))
    await press('toggle')
    const on = await pixels()
    check('开启后红色与浅绿背景均真实绘制', on.red > off.red + 20 && on.green > off.green + 20, JSON.stringify({ off, on }).slice(0, 450))
    const chartRect = await evaluate('(() => {const r=document.querySelector(".dshtrading-tv-chart").getBoundingClientRect();return{x:r.x+r.width*0.65,y:r.y+r.height*0.6}})()')
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...chartRect, deltaY: -220, deltaX: 0 })
    await settle()
    const zoomed = await pixels()
    check('缩放后区间边界重绘', zoomed.edges !== on.edges && zoomed.red + zoomed.green > 20)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...chartRect })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...chartRect, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 6; step++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chartRect.x + step * 30, y: chartRect.y, button: 'left', buttons: 1 })
      await settle()
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: chartRect.x + 180, y: chartRect.y, button: 'left', clickCount: 1 })
    await settle()
    const panned = await pixels()
    check('平移后区间边界重绘', panned.edges !== zoomed.edges && panned.red + panned.green > 20)
    await press('range')
    check('切换日期范围后保留真实数据及图表', await evaluate('document.querySelector("[data-action=range]").textContent.includes("250") && document.querySelectorAll("canvas").length>0'))
    await send('Page.reload')
    for (let i = 0; i < 60; i++) { if (await evaluate('document.querySelector("[data-action=toggle]")?.getAttribute("aria-pressed")==="true"')) break; await new Promise(done => setTimeout(done, 100)) }
    await settle()
    check('刷新后沿用现有状态持久化', await evaluate('document.querySelector("[data-action=toggle]")?.getAttribute("aria-pressed")==="true"'))
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(out, 'amv-enabled.png'), Buffer.from(shot.data, 'base64'))
    await press('toggle')
    const disabled = await pixels()
    check('关闭后背景移除、K线及均线画布保留', disabled.red < on.red && disabled.green < on.green && await evaluate('document.querySelectorAll("canvas").length>0'))
    const closed = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(out, 'amv-disabled.png'), Buffer.from(closed.data, 'base64'))
    check('无未捕获渲染异常', errors.length === 0, errors.join(';'))
    await writeFile(join(out, 'result.json'), JSON.stringify({ mode: 'component-gate-only', baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), worktree: 'uncommitted', testedAt: new Date().toISOString(), sourceFile: history.sourceFile, lastDate: history.lastDate, results }, null, 2))
    if (results.some(result => !result.ok)) throw new Error('AMV chart component gate failed')
  } finally {
    socket?.close()
    if (chrome.pid) {
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
      else { try { process.kill(-chrome.pid, 'SIGKILL') } catch {} }
    }
    await new Promise(done => server.close(done))
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
