import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { VrControlPanel } from './VrControlPanel'
import { VrLinkPanel } from './VrLinkPanel'
import { mapBridgeSnapshot } from './vrLink'
import type { VrBridgeSnapshot } from './vrTypes'
import type { VrLinkView } from './useVrLink'
import { synthesizeOwnership, type VrConsoleSignals } from './vrOwnership'
import { SNAP_FALLBACK, SNAP_FOLLOWING, SNAP_STOPPED } from './__fixtures__/bridgeSnapshots'

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
    q,
    ownership: synthesizeOwnership({
      bridgeOwner: fields.owner,
      bridgeFollowing: fields.following,
      bridgeArmState: fields.armState,
      console: consoleSignals,
    }),
    startFollow: () => {},
    stopFollow: () => {},
    emergencyStop: () => {},
  }
}

/** 桥完全连不上时的视图：整份空态，一个真实字节都没收到过 */
function offlineView(): VrLinkView {
  return viewOf({})
}

describe('VR 面板 · 真实固件渲染', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('跟随中：链路逐跳与桥的开销都显示出来', () => {
    render(<VrLinkPanel vm={viewOf(SNAP_FOLLOWING)} />)

    expect(screen.getByText('跟随中')).toBeTruthy()
    // 逐跳叫的是各自职责（两字 + 服务）；产品名留在「数据源」那一行
    expect(screen.getByText('桥接服务')).toBeTruthy()
    expect(screen.getByText('逆解服务')).toBeTruthy()
    expect(screen.getByText('跟随服务')).toBeTruthy()
    expect(screen.getByText('数据源 · litearm-vr-bridge')).toBeTruthy()
    expect(screen.getByText('桥转发耗时')).toBeTruthy()
    expect(screen.getByText('转发帧数')).toBeTruthy()
    // 逐跳只剩「名称 / 状态」两列：端口是各服务的配置，不在这张表里
    expect(screen.queryByText(/8766/)).toBeNull()
    expect(screen.queryByText(/9001/)).toBeNull()
  })

  it('本页不再就地改桥地址：输入框已移除', () => {
    render(<VrLinkPanel vm={viewOf(SNAP_FOLLOWING)} />)

    expect(screen.queryByRole('textbox')).toBeNull()
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

  it('兜底关闭时按桥的开关说话：写清阈值，不承诺页面上有告警', () => {
    // 桥侧 FALLBACK_ENABLED=0：无帧超时只记事件、不下发 latch，页面没有告警面板可显示
    const snapshot: VrBridgeSnapshot = {
      ...SNAP_FOLLOWING,
      fallback: { active: false, reason: null, guard_enabled: false },
    }
    render(<VrLinkPanel vm={viewOf(snapshot)} />)

    expect(screen.getByText(/FALLBACK_ENABLED=0/)).toBeTruthy()
    expect(screen.getByText(/500 ms 没有新帧也不会自动持位/)).toBeTruthy()
  })

  it('头显时钟不可比时，延迟换成"相对基线"的口径并说明', () => {
    const snapshot: VrBridgeSnapshot = {
      ...SNAP_FOLLOWING,
      headset: { ...SNAP_FOLLOWING.headset, latency_estimated: true },
    }
    render(<VrLinkPanel vm={viewOf(snapshot)} />)

    expect(screen.getByText('无线段延迟（相对基线）')).toBeTruthy()
    expect(screen.getByText(/不是绝对延迟/)).toBeTruthy()
    // 不能再挂着"无线段延迟"这个绝对值口径的标签
    expect(screen.queryByText('无线段延迟')).toBeNull()
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

describe('VR 面板 · 桥连不上时（没有兜底数据）', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('链路面板只说"未连接"，不显示桥版本/耗时这类像真值的东西', () => {
    render(<VrLinkPanel vm={offlineView()} />)

    expect(screen.getByText('数据源 · 未连接')).toBeTruthy()
    // 逐跳如实报未连接，机械臂那一跳也不能写"仿真"（无从判断，见 useVrLink）
    expect(screen.getAllByText('未连接').length).toBeGreaterThanOrEqual(5)
    // 转发耗时/丢弃/拦截都得是空，不然会被当成链路在跑
    expect(screen.queryByText(/^v0\./)).toBeNull()
  })

  it('控制面板：三个按钮全禁用，并说明发不出去', () => {
    render(<VrControlPanel vm={offlineView()} />)

    for (const name of [/开始遥操/, /停止遥操/, /急停/]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByText(/桥未连接：三个按钮都发不出去/)).toBeTruthy()
  })
})
