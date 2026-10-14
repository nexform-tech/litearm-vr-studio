import { describe, expect, it } from 'vitest'
import { emptyBridgeFields, mapBridgeSnapshot } from './vrLink'
import { SNAP_FALLBACK, SNAP_FOLLOWING, SNAP_NO_HEADSET, SNAP_STOPPED } from './__fixtures__/bridgeSnapshots'

/**
 * 固件是 litearm-vr-bridge 的真实 `/ws/status` 载荷（见 __fixtures__ 里的说明），
 * 所以这些用例同时钉住两件事：桥的契约没变、页面对桥的解读是对的。
 */

describe('mapBridgeSnapshot · 头显与转发指标', () => {
  it('把跟随态快照映射成页面字段', () => {
    const { fields, q } = mapBridgeSnapshot(SNAP_FOLLOWING)

    expect(fields.bridgeOnline).toBe(true)
    expect(fields.headsetOnline).toBe(true)
    expect(fields.following).toBe(true)
    expect(fields.linkState).toBe('following')
    expect(fields.grip).toBe(true)
    expect(fields.tracked).toBe(true)
    expect(fields.armSource).toBe('real')
    expect(fields.armConnected).toBe(true)
    expect(fields.armState).toBe('following')
    expect(fields.metavrConnected).toBe(true)
    expect(fields.owner).toBe('vr')
    expect(fields.fallbackActive).toBe(false)
    expect(fields.forwardEnabled).toBe(true)
    expect(fields.rearmRequired).toBe(false)

    // 桥自身的开销：DESIGN 要求 < 1ms
    expect(fields.forwardCostMs).toBeGreaterThan(0)
    expect(fields.forwardCostMs).toBeLessThan(1)

    // 帧计数是"累计收到的帧"，页面展示的是已转发帧数
    expect(fields.frames).toBeGreaterThan(0)
    expect(fields.framesForwarded).toBeGreaterThan(0)
    expect(fields.framesDropped).toBe(0)
    expect(fields.framesBlocked).toBe(0)

    // 只有长度 7 且都是有限数的 q 才采用
    expect(q).toHaveLength(7)
    expect(q?.[1]).toBeLessThan(0)
    expect(fields.faultCount).toBe(0)
  })

  it('头显未接入时给出可用的空态', () => {
    const { fields, q } = mapBridgeSnapshot(SNAP_NO_HEADSET)

    expect(fields.headsetOnline).toBe(false)
    expect(fields.following).toBe(false)
    expect(fields.linkState).toBe('idle')
    expect(fields.bridgeOnline).toBe(true)
    expect(fields.metavrConnected).toBe(true)
    // 桥在线但头显没推帧：q 仍然是桥 ping 到的真机姿态
    expect(q).toHaveLength(7)
    expect(fields.sinceFrameMs).toBe(0)
  })
})

describe('mapBridgeSnapshot · 安全状态', () => {
  it('兜底态要能被页面一眼识别', () => {
    const { fields } = mapBridgeSnapshot(SNAP_FALLBACK)

    expect(fields.fallbackActive).toBe(true)
    expect(fields.fallbackReason).toBe('no_frame>500ms')
    expect(fields.fallbackGuardEnabled).toBe(true)
    expect(fields.linkState).toBe('fallback')
    // 兜底是"没帧"触发的：头显判离线、且不再跟随
    expect(fields.headsetOnline).toBe(false)
    expect(fields.following).toBe(false)
    expect(fields.grip).toBe(true) // 手还握着，但已经不算跟随
    expect(fields.warnMs).toBe(200)
    expect(fields.fallbackMs).toBe(500)
    expect(fields.sinceFrameMs).toBeGreaterThan(fields.fallbackMs)
  })

  it('停止遥操后：转发关闭、需重新按 grip', () => {
    const { fields } = mapBridgeSnapshot(SNAP_STOPPED)

    expect(fields.forwardEnabled).toBe(false)
    expect(fields.linkEnabled).toBe(false)
    expect(fields.linkState).toBe('latched')
    expect(fields.rearmRequired).toBe(true)
    expect(fields.following).toBe(false)
    // 头显还在推帧，但都被桥拦下了
    expect(fields.headsetOnline).toBe(true)
    expect(fields.framesBlocked).toBeGreaterThan(0)
  })
})

describe('字段缺失 / 桥换版本时的健壮性', () => {
  it('空快照退成空态而不是抛错', () => {
    const { fields, q } = mapBridgeSnapshot({})

    expect(q).toBeNull()
    expect(fields).toMatchObject({
      bridgeOnline: false,
      linkState: 'idle',
      owner: 'none',
      fallbackReason: null,
      warnMs: 200,
      fallbackMs: 500,
      fallbackGuardEnabled: true,
      forwardEnabled: true,
    })
  })

  it('q 长度不对时保留上一帧（返回 null）', () => {
    expect(mapBridgeSnapshot({ arm: { q: [1, 2, 3] } }).q).toBeNull()
    // 运行期可能收到脏数据（长度对但含非数值），这里就要挡下来
    const dirty = [1, 2, 3, 4, 5, 6, 'x'] as unknown as number[]
    expect(mapBridgeSnapshot({ arm: { q: dirty } }).q).toBeNull()
    expect(mapBridgeSnapshot({ arm: { q: null } }).q).toBeNull()
  })

  it('空态基线里没有任何"看起来像真值"的东西', () => {
    const empty = emptyBridgeFields()
    const keys = Object.keys(empty).sort()
    expect(keys).toContain('forwardCostMs')
    expect(keys).toContain('fallbackActive')
    expect(keys).toContain('owner')
    expect(keys).toContain('linkState')

    // 桥连不上时页面照实显示空态：计数归零、状态归 idle、没有 v/fps/latency 这类
    // 会被当成"链路正常"的数。以前这里由演示数据填满，正是"数据全是假的"的来源。
    expect(empty.bridgeOnline).toBe(false)
    expect(empty.headsetOnline).toBe(false)
    expect(empty.headsetConnected).toBe(false)
    expect(empty.following).toBe(false)
    expect(empty.fps).toBe(0)
    expect(empty.frames).toBe(0)
    expect(empty.framesForwarded).toBe(0)
    expect(empty.bridgeVersion).toBe('')
    expect(empty.linkState).toBe('idle')
  })
})
