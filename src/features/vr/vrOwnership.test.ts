import { describe, expect, it } from 'vitest'
import { consoleActivityOf, synthesizeOwnership, type VrConsoleSignals } from './vrOwnership'

/**
 * 跨两条链路的归属合成：VR 侧来自桥（只有 vr / none），上位机侧来自 studio 自己
 * 的 litearm-server 连接。这组用例钉住"谁在控"的判定口径 —— 尤其是
 * **连着但空闲不算在控**（studio 一打开就连 7449，否则 VR 永远起不来）。
 */

const offline: VrConsoleSignals = { connected: false, endpoint: '', motionBusy: false, robotState: null }

function consoleSignals(patch: Partial<VrConsoleSignals> = {}): VrConsoleSignals {
  return { connected: true, endpoint: '192.168.31.139:7449', motionBusy: false, robotState: 'holding', ...patch }
}

function synth(bridge: Partial<{ owner: string; following: boolean; armState: string | null }>, console = offline) {
  return synthesizeOwnership({
    bridgeOwner: bridge.owner ?? 'none',
    bridgeFollowing: bridge.following ?? false,
    bridgeArmState: bridge.armState ?? null,
    console,
  })
}

describe('consoleActivityOf · 上位机侧是否真的在驱动机械臂', () => {
  it('没连上 litearm-server 就谈不上在控', () => {
    expect(consoleActivityOf({ ...offline, motionBusy: true, robotState: 'moving' })).toBeNull()
  })

  it('静止态（ready / holding）不算在控', () => {
    expect(consoleActivityOf(consoleSignals({ robotState: 'ready' }))).toBeNull()
    expect(consoleActivityOf(consoleSignals({ robotState: 'holding' }))).toBeNull()
    expect(consoleActivityOf(consoleSignals({ robotState: null }))).toBeNull()
  })

  it('运动指令在途（motionBusy）算在控', () => {
    expect(consoleActivityOf(consoleSignals({ motionBusy: true, robotState: 'ready' }))).toBe('motion')
  })

  it('把 litearm-server 的状态机映射成活动类型', () => {
    expect(consoleActivityOf(consoleSignals({ robotState: 'moving' }))).toBe('motion')
    expect(consoleActivityOf(consoleSignals({ robotState: 'following' }))).toBe('following')
    expect(consoleActivityOf(consoleSignals({ robotState: 'zero_gravity' }))).toBe('zero_gravity')
    expect(consoleActivityOf(consoleSignals({ robotState: 'joint_impedance' }))).toBe('impedance')
    expect(consoleActivityOf(consoleSignals({ robotState: 'cartesian_impedance' }))).toBe('impedance')
    expect(consoleActivityOf(consoleSignals({ robotState: 'stopping' }))).toBe('stopping')
    expect(consoleActivityOf(consoleSignals({ robotState: 'fault' }))).toBeNull()
  })
})

describe('synthesizeOwnership · 两条链路合成', () => {
  it('都没在动 → none（哪怕上位机连着）', () => {
    expect(synth({ owner: 'none' }, consoleSignals()).owner).toBe('none')
    expect(synth({ owner: 'none' }, consoleSignals()).conflict).toBe(false)
  })

  it('只有桥报 VR 在控 → vr', () => {
    const o = synth({ owner: 'vr', following: true, armState: 'following' }, consoleSignals())
    expect(o.vrActive).toBe(true)
    expect(o.console.inControl).toBe(false)
    expect(o.owner).toBe('vr')
    expect(o.conflict).toBe(false)
  })

  it('桥报 none 但上位机在动 → console（不能照抄桥的 none）', () => {
    const o = synth({ owner: 'none' }, consoleSignals({ motionBusy: true }))
    expect(o.owner).toBe('console')
    expect(o.console.inControl).toBe(true)
    expect(o.console.activity).toBe('motion')
    expect(o.conflict).toBe(false)
  })

  it('两侧都在控 → conflict', () => {
    const o = synth({ owner: 'vr', following: true }, consoleSignals({ robotState: 'following' }))
    expect(o.conflict).toBe(true)
    expect(o.owner).toBe('conflict')
  })

  it('桥只报真机处于被跟随状态（following / MOVE_JS）也算 VR 在控', () => {
    // 老桥/降级路径：owner 没给对，但真机状态说明它正被 metavr 跟随
    expect(synth({ owner: 'none', armState: 'MOVE_JS' }).vrActive).toBe(true)
    expect(synth({ owner: 'none', armState: 'following' }).vrActive).toBe(true)
    // 只是持位/空闲不算
    expect(synth({ owner: 'none', armState: 'holding' }).vrActive).toBe(false)
    expect(synth({ owner: 'none', armState: null }).vrActive).toBe(false)
  })
})
