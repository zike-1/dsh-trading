/**
 * 本地 A 股数据目录配置：环境变量 > local-data.json > 未配置（不猜默认安装路径）。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { amvCalendarFile, amvFile, readLocalDataConfig, tdxDir, tdxGbbqFile } from '../src/local-data-config.ts'

const ENV_KEYS = ['DSH_TRADING_LOCAL_DATA_CONFIG', 'DSH_TRADING_TDX_DIR', 'DSH_TRADING_AMV_FILE', 'DSH_TRADING_TDX_GBBQ_FILE', 'DSH_TRADING_AMV_CALENDAR_FILE']
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

async function configFile(content: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'local-data-'))
  const file = path.join(dir, 'local-data.json')
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  return file
}

describe('local-data.json', () => {
  it('没有配置文件也没有环境变量：全部未配置，不猜默认路径', () => {
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.DSH_TRADING_LOCAL_DATA_CONFIG = path.join(os.tmpdir(), 'definitely-missing-local-data.json')
    expect([tdxDir(), tdxGbbqFile(), amvFile(), amvCalendarFile()]).toEqual([undefined, undefined, undefined, undefined])
  })

  it('配置文件给出目录，派生出各个文件路径', async () => {
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.DSH_TRADING_LOCAL_DATA_CONFIG = await configFile({ tdxDir: 'X:/tdx', zhinanzhenDataDir: 'Y:/znz/ChinaStk' })
    expect(tdxDir()).toBe('X:/tdx')
    expect(tdxGbbqFile()).toBe(path.join('X:/tdx', 'T0002', 'hq_cache', 'gbbq'))
    expect(amvFile()).toBe(path.join('Y:/znz/ChinaStk', 'Z_SK', 'day.vdat'))
    expect(amvCalendarFile()).toBe(path.join('X:/tdx', 'vipdoc', 'sh', 'lday', 'sh000001.day'))
  })

  it('环境变量优先于配置文件；坏 JSON 当作未配置', async () => {
    process.env.DSH_TRADING_LOCAL_DATA_CONFIG = await configFile({ tdxDir: 'X:/tdx' })
    process.env.DSH_TRADING_TDX_DIR = 'Z:/override'
    expect(tdxDir()).toBe('Z:/override')
    expect(readLocalDataConfig(await configFile('{not json'))).toEqual({})
  })
})
