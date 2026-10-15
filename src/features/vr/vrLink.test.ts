import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { armQ, emptyBridgeFields, formatArmFault, mapBridgeSnapshot, vrLink } from './vrLink'
import {
  SNAP_FALLBACK,
  SNAP_FOLLOWING,
  SNAP_NO_HEADSET,
  SNAP_STOPPED,
} from './__fixtures__/bridgeSnapshots'
import type { VrBridgeSnapshot } from './vrTypes'

/**
 * 固件是 litearm-vr-bridge 的真实 `/ws/status` 载荷（见 __fixtures__ 里的说明），
 * 所以这些用例同时钉住两件事：桥的契约没变、页面对桥的解读是对的。
 *
 * 关节角**不在**桥那份固件里：它来自上游汇总服务发的 `vr_arm`（见 `armQ` 与下面
 * 「逐臂视图」那一段）。
 */

/**
 * 假 daemon 客户端：`vrLink` 只从它读那几样（桥在线、认到哪些臂、每臂的快照与真机状态），
 * 所以这里实现同样多的接口就够，页面那一侧的行为不必连真的 WebSocket 才能钉住。
 */
const fake = vi.hoisted(() => {
  const state = {
    online: false,
    arms: [] as string[],
    snapshots: new Map<string, VrBridgeSnapshot>(),
    armStates: new Map<string, Record<string, unknown>>(),
    listeners: new Set<() => void>(),
  }
  return {
    state,
    vrBridge: {
      get online() {
        return state.online
      },
      get arms() {
        return [...state.arms].sort()
      },
      snapshotFor: (arm: string) => state.snapshots.get(arm) ?? null,
      armStateFor: (arm: string) => state.armStates.get(arm) ?? null,
      gripStateFor: () => null,
      subscribe: (cb: () => void) => {
        state.listeners.add(cb)
        return () => {
          state.listeners.delete(cb)
        }
      },
      start: () => {},
      stop: () => {},
      sendAction: () => true,
    },
    feed: (next: {
      online: boolean
      snapshots?: Record<string, VrBridgeSnapshot>
      armStates?: Record<string, Record<string, unknown>>
    }) => {
      state.online = next.online
      state.snapshots = new Map(Object.entries(next.snapshots ?? {}))
      state.armStates = new Map(Object.entries(next.armStates ?? {}))
      state.arms = [...state.snapshots.keys()]
    },
  }
})

vi.mock('./vrDaemonClient', () => ({ vrBridge: fake.vrBridge }))

describe('mapBridgeSnapshot · 头显与转发指标', () => {
  it('把跟随态快照映射成页面字段', () => {
    const fields = mapBridgeSnapshot(SNAP_FOLLOWING)

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

    expect(fields.armFault).toEqual([])
  })

  it('头显未接入时给出可用的空态', () => {
    const fields = mapBridgeSnapshot(SNAP_NO_HEADSET)

    expect(fields.headsetOnline).toBe(false)
    expect(fields.following).toBe(false)
    expect(fields.linkState).toBe('idle')
    expect(fields.bridgeOnline).toBe(true)
    expect(fields.metavrConnected).toBe(true)
    expect(fields.sinceFrameMs).toBe(0)
  })
})

describe('mapBridgeSnapshot · 安全状态', () => {
  it('兜底态要能被页面一眼识别', () => {
    const fields = mapBridgeSnapshot(SNAP_FALLBACK)

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
    const fields = mapBridgeSnapshot(SNAP_STOPPED)

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
    expect(mapBridgeSnapshot({})).toMatchObject({
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

/**
 * 跟随服务的故障与错误（`arm.fault` / `arm.error`）。
 *
 * 固件里那四份真快照这两个字段都是空的（健康的桥就是这么报的），所以这里用手写的载荷，
 * 而不是往 `__fixtures__` 里塞一份假的"真快照"——那份文件的规矩是从真桥抓下来的。
 */
describe('mapBridgeSnapshot · 跟随服务的故障', () => {
  it('故障码原样留着，不是只留一个数', () => {
    const faults = [[3, 5], 'FB_STALE']
    expect(mapBridgeSnapshot({ arm: { fault: faults } }).armFault).toEqual(faults)
  })

  it('健康（空数组）与"桥没报过"（null）分得开', () => {
    expect(mapBridgeSnapshot({ arm: { fault: [] } }).armFault).toEqual([])
    expect(mapBridgeSnapshot({ arm: { fault: null } }).armFault).toBeNull()
    expect(mapBridgeSnapshot({ arm: {} }).armFault).toBeNull()
    expect(emptyBridgeFields().armFault).toBeNull()
  })

  it('错误原因照实映射，没有就是 null', () => {
    expect(mapBridgeSnapshot({ arm: { error: 'TimeoutError: ' } }).armError).toBe('TimeoutError: ')
    expect(mapBridgeSnapshot({ arm: { error: null } }).armError).toBeNull()
  })
})

describe('formatArmFault', () => {
  it('sdk 版的两元组写成「哪个关节、什么错」', () => {
    expect(formatArmFault([3, 5])).toBe('J3: 5')
  })

  it('stm32 版的 flag 名字原样显示', () => {
    expect(formatArmFault('FB_STALE')).toBe('FB_STALE')
  })

  it('认不出来的东西也不吞掉', () => {
    // 宁可显示一个不好看的字符串，也不要让一条故障在界面上消失
    expect(formatArmFault(null)).toBe('null')
    expect(formatArmFault([1])).toBe('J1: undefined')
  })
})

/**
 * 关节角来自真机状态（`vr_arm` 的 `q`），不再是桥快照里那段。
 *
 * 长度不对或含非数一律不采用：本页的 3D 模型就是 7 轴，拿一个长度不对的数组去驱动它，
 * 画面会比不更新更假。返回 null 时调用方保留上一组值（见「逐臂视图」里的用例）。
 */
describe('armQ', () => {
  const SEVEN = [0.019, -0.0711, -0.09, -1.7153, -1.46, -0.0148, -0.79]

  it('长度 7 且都是数才采用', () => {
    expect(armQ({ q: SEVEN })).toEqual(SEVEN)
  })

  it('长度不对、含非数、没有 q，一律 null', () => {
    expect(armQ({ q: [1, 2, 3] })).toBeNull()
    expect(armQ({ q: [1, 2, 3, 4, 5, 6, 'x'] })).toBeNull()
    expect(armQ({ q: null })).toBeNull()
    expect(armQ({})).toBeNull()
    expect(armQ(null)).toBeNull()
  })
})

/**
 * 逐臂视图：桥认到几条臂就有几条，姿态与设备名取各自那份真机状态。
 *
 * 用假的 daemon 客户端喂数据（真帧的解析在 `vrDaemonClient.test.ts` 与 daemon 那边测），
 * 这里钉的是页面这一侧的编排：谁算一条臂、掉线时留什么、桥改口以后删什么。
 */
describe('vrLink · 逐臂视图', () => {
  const Q_A = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
  const Q_B = [-0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7]

  beforeEach(() => {
    fake.feed({ online: false })
  })

  afterEach(() => {
    vrLink.stop()
  })

  it('两条臂各自一条：身份、设备名、跟随态与故障都是各自那份', async () => {
    fake.feed({
      online: true,
      snapshots: {
        armA: SNAP_FOLLOWING,
        // 第二条臂：不跟随、带一条故障
        armB: {
          ...SNAP_FOLLOWING,
          headset: { ...SNAP_FOLLOWING.headset, following: false },
          arm: { ...SNAP_FOLLOWING.arm, fault: ['FB_STALE'] },
        },
      },
      armStates: {
        armA: { device: '/dev/ttyACM0', connected: true, q: Q_A },
        armB: { device: 'can0', connected: true, q: Q_B },
      },
    })
    vrLink.start()

    await waitFor(() => expect(vrLink.arms).toHaveLength(2))
    const [a, b] = vrLink.arms
    expect(a.arm).toBe('armA')
    expect(a.device).toBe('/dev/ttyACM0')
    expect(a.q).toEqual(Q_A)
    expect(a.following).toBe(true)
    expect(a.armFault).toEqual([])
    expect(b.arm).toBe('armB')
    expect(b.device).toBe('can0')
    expect(b.q).toEqual(Q_B)
    expect(b.following).toBe(false)
    expect(b.armFault).toEqual(['FB_STALE'])
    // 整机那一份是第一条臂：控制卡与链路卡的既有口径不动
    expect(vrLink.snapshot.q).toEqual(Q_A)
  })

  it('关节角取真机状态那一份，不是桥快照里残留的', async () => {
    const bridgeQ = [9, 9, 9, 9, 9, 9, 9]
    fake.feed({
      online: true,
      snapshots: { armA: { ...SNAP_FOLLOWING, arm: { ...SNAP_FOLLOWING.arm, q: bridgeQ } } },
      armStates: { armA: { device: '/dev/ttyACM0', connected: true, q: Q_A } },
    })
    vrLink.start()

    await waitFor(() => expect(vrLink.arms).toHaveLength(1))
    expect(vrLink.arms[0].q).toEqual(Q_A)
    expect(vrLink.poseFor('armA')).toEqual(Q_A)
  })

  it('桥掉线：字段归空态，臂清单与姿态留着（不是零位）', async () => {
    fake.feed({
      online: true,
      snapshots: { armA: SNAP_FOLLOWING },
      armStates: { armA: { device: '/dev/ttyACM0', connected: true, q: Q_A } },
    })
    vrLink.start()
    await waitFor(() => expect(vrLink.arms).toHaveLength(1))
    expect(vrLink.arms[0].bridgeOnline).toBe(true)

    fake.feed({ online: false })

    await waitFor(() => expect(vrLink.snapshot.bridgeOnline).toBe(false))
    await waitFor(() => expect(vrLink.arms[0].bridgeOnline).toBe(false))
    expect(vrLink.arms[0].q).toEqual(Q_A)
    expect(vrLink.poseFor('armA')).toEqual(Q_A)
  })

  it('桥改口只报一条臂时，不再报的那条从页面上删掉', async () => {
    fake.feed({
      online: true,
      snapshots: { armA: SNAP_FOLLOWING, armB: SNAP_FOLLOWING },
      armStates: {
        armA: { device: '/dev/ttyACM0', connected: true, q: Q_A },
        armB: { device: 'can0', connected: true, q: Q_B },
      },
    })
    vrLink.start()
    await waitFor(() => expect(vrLink.arms).toHaveLength(2))

    fake.feed({
      online: true,
      snapshots: { armA: SNAP_FOLLOWING },
      armStates: { armA: { device: '/dev/ttyACM0', connected: true, q: Q_A } },
    })

    await waitFor(() => expect(vrLink.arms.map((view) => view.arm)).toEqual(['armA']))
  })

  it('姿态按臂分开通知：只有那条臂的订阅者被叫醒', async () => {
    fake.feed({
      online: true,
      snapshots: { armA: SNAP_FOLLOWING, armB: SNAP_FOLLOWING },
      armStates: {
        armA: { device: '/dev/ttyACM0', connected: true, q: Q_A },
        armB: { device: 'can0', connected: true, q: Q_B },
      },
    })
    vrLink.start()
    await waitFor(() => expect(vrLink.arms).toHaveLength(2))

    const seenA: number[][] = []
    const seenB: number[][] = []
    const offA = vrLink.subscribePose('armA', (q) => seenA.push(q))
    const offB = vrLink.subscribePose('armB', (q) => seenB.push(q))

    const Q_A2 = [0.11, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
    fake.state.armStates.set('armA', { device: '/dev/ttyACM0', connected: true, q: Q_A2 })

    await waitFor(() => expect(seenA).toHaveLength(1))
    expect(seenA[0]).toEqual(Q_A2)
    expect(seenB).toHaveLength(0)

    offA()
    offB()
  })
})
