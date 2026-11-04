/**
 * 2026-11-02 实测：页面加载时 Worker 启动慢，合法的自定义指标被 100ms 试算熔断判成
 * 死循环，这次加载整个消失。这里钉住默认校验用的是放宽后的熔断。
 */
import { describe, expect, it } from 'vitest'
import { validateStoredIndicator } from '../src/client/indicator-load.ts'

describe('自定义指标加载的试算熔断', () => {
  it('用户刷新页面时已保存的指标不会因为 Worker 启动慢被判超时', async () => {
    // Given 一个记录入参的校验器
    let trialTimeoutMs: number | undefined
    // When 走默认校验
    await validateStoredIndicator({ id: 'x' }, async (_raw, options) => {
      trialTimeoutMs = options?.trialTimeoutMs
      return { ok: false, reason: 'stop' }
    })
    // Then 熔断远大于默认的 100ms
    expect(trialTimeoutMs).toBeGreaterThanOrEqual(1000)
  })
})
