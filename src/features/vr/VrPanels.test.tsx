import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { VrControlPanel } from './VrControlPanel'
import { VrEventsPanel } from './VrEventsPanel'
import { VrLinkPanel } from './VrLinkPanel'
import { VrProcessPanel } from './VrProcessPanel'
import { mapBridgeSnapshot, mergeEvents } from './vrLink'
import type { VrBridgeSnapshot } from './vrTypes'
import type { VrLinkView } from './useVrLink'
import { synthesizeOwnership, type VrConsoleSignals } from './vrOwnership'
import {
  SNAP_FALLBACK,
  SNAP_FOLLOWING,
  SNAP_PROCESS_CRASHED,
  SNAP_STOPPED,
} from './__fixtures__/bridgeSnapshots'

/**
 * 用真实固件把三个面板渲染一遍：i18n 键写错、字段改名、条件分支漏判都会在这里炸。
 */

const CONSOLE_OFFLINE: VrConsoleSignals = {
  connected: false,
  endpoint: '',
  motionBusy: false,
  robotState: null,
}

function viewOf(snapshot: VrBridgeSnapshot, consoleSignals: VrConsoleSignals = CONSOLE_OFFLINE): VrLinkView {
  const { fields, q } = mapBridgeSnapshot(snapshot)
  return {
    ...fields,
    q: q ?? [0, -0.07, -0.09, -1.7, -1.46, -0.03, -0.79],
    events: mergeEvents([], (snapshot.events ?? []).filter(Boolean)),
    ownership: synthesizeOwnership({
      bridgeOwner: fields.owner,
      bridgeFollowing: fields.following,
      bridgeArmState: fields.armState,
      console: consoleSignals,
    }),
    offlineDemo: false,
    bridgeEndpoint: 'ws://localhost:8765/ws/status',
    startFollow: () => {},
    stopFollow: () => {},
    emergencyStop: () => {},
    setOfflineDemo: () => {},
    startProcess: () => {},
    stopProcess: () => {},
    dismissEvent: () => {},
    clearEvents: () => {},
    setBridgeEndpoint: () => {},
  }
}

describe('VR 面板 · 真实固件渲染', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('跟随中：链路逐跳与桥的开销都显示出来', () => {
    render(<VrLinkPanel vm={viewOf(SNAP_FOLLOWING)} />)

    expect(screen.getByText('跟随中')).toBeTruthy()
    expect(screen.getByText('litearm-vr-bridge')).toBeTruthy()
    expect(screen.getByText('metavr 中继')).toBeTruthy()
    expect(screen.getByText('跟随服务')).toBeTruthy()
    expect(screen.getByText('桥转发耗时')).toBeTruthy()
    expect(screen.getByText('转发帧数')).toBeTruthy()
  })

  it('兜底态：徽标与红条都指向兜底（而不是"未连接"）', () => {
    render(<VrLinkPanel vm={viewOf(SNAP_FALLBACK)} />)

    expect(screen.getByText('已进入兜底持位')).toBeTruthy()
    expect(screen.getByText(/no_frame>500ms/)).toBeTruthy()
    // 兜底时头显必然判离线，但徽标要说兜底
    expect(screen.getByText('兜底持位')).toBeTruthy()
    // 逐跳里头显那一跳仍然是"未连接"（如实反映它确实不推帧了）
    expect(screen.getAllByText('未连接').length).toBeGreaterThan(0)
  })

  it('停止遥操后：拦截计数与重按提示可见', () => {
    render(<VrLinkPanel vm={viewOf(SNAP_STOPPED)} />)

    expect(screen.getByText('已连接 · 持位')).toBeTruthy()
    expect(screen.getAllByText('拦截').length).toBeGreaterThan(0)
    expect(screen.getByText(/需重新按一次右手 grip/)).toBeTruthy()
  })

  it('事件面板把桥的告警原样列出来', () => {
    render(<VrEventsPanel vm={viewOf(SNAP_FALLBACK)} />)

    expect(screen.getByText('fallback_latch')).toBeTruthy()
    expect(screen.getByText('frame_stall')).toBeTruthy()
    expect(screen.getByText('latch_done')).toBeTruthy()
  })

  it('进程面板：崩溃进程显示退出码，未运行的可启动', () => {
    const vm = viewOf(SNAP_PROCESS_CRASHED)
    render(<VrProcessPanel vm={vm} />)

    expect(screen.getByText('metavr')).toBeTruthy()
    expect(screen.getByText('follow_server')).toBeTruthy()
    expect(screen.getByText('已崩溃')).toBeTruthy()
    expect(screen.getByText('已停止')).toBeTruthy()
    expect(screen.getByText(/退出码 3/)).toBeTruthy()
  })

  it('控制面板：桥在线时提示语说的是真实链路，不是演示', () => {
    render(<VrControlPanel vm={viewOf(SNAP_STOPPED)} />)

    expect(screen.getByText(/都会作用到机械臂/)).toBeTruthy()
    expect(screen.getByText(/已停止或急停过/)).toBeTruthy()
    expect(screen.queryByText(/只改页面状态/)).toBeNull()
  })

  it('控制面板：上位机侧在控时给出互斥提示并拦住"开始遥操"', () => {
    // 桥报 owner=none、头显在线但没跟随（VR 侧空闲），studio 这一侧却在跑运动指令
    const vm = viewOf(SNAP_STOPPED, {
      connected: true,
      endpoint: '192.168.31.139:7449',
      motionBusy: true,
      robotState: 'moving',
    })
    render(<VrControlPanel vm={vm} />)

    expect(screen.getByText('上位机正在控制机械臂')).toBeTruthy()
    expect(screen.getByText(/正在执行运动指令/)).toBeTruthy()
    expect(screen.getByText('192.168.31.139:7449')).toBeTruthy()
    // 合成后的归属是"上位机"，而不是照抄桥的 none
    expect(screen.getByText('上位机')).toBeTruthy()
    expect(vm.following).toBe(false)
    expect(vm.headsetOnline).toBe(true)
    expect((screen.getByRole('button', { name: /开始遥操/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('控制面板：两条链路同时在控时报警（合成归属 conflict）', () => {
    const vm = viewOf(SNAP_FOLLOWING, {
      connected: true,
      endpoint: '192.168.31.139:7449',
      motionBusy: false,
      robotState: 'zero_gravity',
    })
    render(<VrControlPanel vm={vm} />)

    expect(screen.getByText('两条链路同时在控机械臂')).toBeTruthy()
    expect(screen.getByText('两条链路同时在控')).toBeTruthy()
    expect(vm.ownership.conflict).toBe(true)
    expect((screen.getByRole('button', { name: /开始遥操/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('控制面板：上位机连着但空闲不算在控（VR 仍可开始）', () => {
    const vm = viewOf(SNAP_STOPPED, {
      connected: true,
      endpoint: '192.168.31.139:7449',
      motionBusy: false,
      robotState: 'holding',
    })
    render(<VrControlPanel vm={vm} />)

    expect(vm.ownership.console.inControl).toBe(false)
    expect(vm.ownership.owner).toBe('none')
    expect(screen.getByText(/当前空闲/)).toBeTruthy()
    expect(screen.queryByText('上位机正在控制机械臂')).toBeNull()
  })
})
