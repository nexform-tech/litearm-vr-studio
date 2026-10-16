import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { VrControlPanel } from './VrControlPanel'
import { VrLinkPanel } from './VrLinkPanel'
import { armFieldsOf, mapBridgeSnapshot, type VrArmView } from './vrLink'
import type { VrBridgeSnapshot } from './vrTypes'
import type { VrLinkView } from './useVrLink'
import { synthesizeOwnership, type VrConsoleSignals } from './vrOwnership'
import {
  SNAP_FALLBACK,
  SNAP_FOLLOWING,
  SNAP_NO_HEADSET,
  SNAP_STOPPED,
} from './__fixtures__/bridgeSnapshots'
import {
  ARM_FOLLOWING,
  ARM_HOLDING,
  armStatus,
  type ArmStatusFrame,
} from './__fixtures__/armStatus'

/**
 * 用真实固件把三个面板渲染一遍：i18n 键写错、字段改名、条件分支漏判都会在这里炸。
 */

const CONSOLE_OFFLINE: VrConsoleSignals = {
  connected: false,
  endpoint: '',
  motionBusy: false,
  robotState: null,
}

/**
 * 整页视图：桥的快照（链路那一段）+ 真机状态（臂那一段）**分开喂** —— 与线上一样，
 * 这是两份独立的数据源（见 `vrLink.readArm`）。
 */
function viewOf(
  snapshot: VrBridgeSnapshot,
  consoleSignals: VrConsoleSignals = CONSOLE_OFFLINE,
  arms: VrArmView[] = [],
  status: ArmStatusFrame | null = ARM_HOLDING,
): VrLinkView {
  const fields = mapBridgeSnapshot(snapshot)
  const armFields = armFieldsOf(status)
  return {
    ...fields,
    ...armFields,
    // 关节角走 3D 视口那条高频通道（`vrLink.poseFor`），不在这份视图里
    q: null,
    arms,
    ownership: synthesizeOwnership({
      bridgeOwner: fields.owner,
      bridgeFollowing: fields.following,
      bridgeArmState: armFields.armState,
      console: consoleSignals,
    }),
    startFollow: () => {},
    stopFollow: () => {},
    emergencyStop: () => {},
  }
}

/** 一条臂的视图：与 `vrLink` 的逐臂视图同形（整机字段 + 臂身份 + 真机状态）。 */
function armViewOf(
  arm: string,
  device: string,
  status: ArmStatusFrame | null = ARM_FOLLOWING,
  side = 'left',
): VrArmView {
  return {
    ...mapBridgeSnapshot(SNAP_FOLLOWING),
    ...armFieldsOf(status),
    q: null,
    arm,
    side,
    device,
  }
}

/** 桥完全连不上时的视图：整份空态，一个真实字节都没收到过 */
function offlineView(): VrLinkView {
  // 真机状态也一帧都没有：`status` 传 null，臂那一组才是空态
  return viewOf({}, CONSOLE_OFFLINE, [], null)
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

  it('控制面板：停过遥操就提示要重按 grip（卡片里只剩按钮与归属）', () => {
    render(<VrControlPanel vm={viewOf(SNAP_STOPPED)} />)

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
    // 上位机空闲就不出告警条，也不拦"开始遥操"
    expect(screen.queryByText('上位机正在控制机械臂')).toBeNull()
    expect((screen.getByRole('button', { name: /开始遥操/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('VR 面板 · 桥连不上时（没有兜底数据）', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('桥连不上时：徽标不出现（没有状态可报），数据源那一行也不出现', () => {
    render(<VrLinkPanel vm={offlineView()} />)

    // 徽标只报状态机那一档；通断由流程条上每一格自己说，不再重复一句"桥未连接"
    expect(screen.queryByText('跟随中')).toBeNull()
    expect(screen.queryByText('已连接 · 待机')).toBeNull()
    // 数据源那一行讲的是"哪一路、什么版本、跑了多久"，桥不在时这三样都没意义
    expect(screen.queryByText(/^数据源 · /)).toBeNull()
    // 五跳逐跳如实报未连接，机械臂那一跳也不能写"仿真"（无从判断，见 useVrLink）
    expect(screen.getAllByText('未连接')).toHaveLength(5)
    // 转发耗时/丢弃/拦截都得是空，不然会被当成链路在跑
    expect(screen.queryByText(/^v0\./)).toBeNull()
  })

  it('桥在、头显不推帧时：徽标报状态机的"待机"，头显那一格自己说未连接', () => {
    render(<VrLinkPanel vm={viewOf(SNAP_NO_HEADSET)} />)

    expect(screen.getByText('已连接 · 待机')).toBeTruthy()
    // 头显那一跳如实报未连接 —— 通断只在流程条上说
    expect(screen.getByText('未连接')).toBeTruthy()
    // 数据源那一行照常：桥是连着的
    expect(screen.getByText('数据源 · litearm-vr-bridge')).toBeTruthy()
  })

  it('控制面板：三个按钮全禁用', () => {
    render(<VrControlPanel vm={offlineView()} />)

    for (const name of [/开始遥操/, /停止遥操/, /急停/]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })
})

/**
 * 跟随服务的故障与错误：桥报得出"为什么"，页面以前一个字都不说。
 *
 * 载荷是手写的：真快照里这两个字段始终是空的（健康的桥就这么报），所以这里没法拿真固件钉。
 */
describe('VR 链路卡 · 跟随服务的故障与错误', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('故障码两种形状都显示出来，而不是只说"有故障"', () => {
    // 两种形状是真的会同时出现：stm32 版的置位名在 `flags`，sdk 版的两元组在 `fault`
    const faulty = armStatus({ flags: ['FB_STALE'], fault: [[3, 5]] })
    render(<VrLinkPanel vm={viewOf(SNAP_FOLLOWING, CONSOLE_OFFLINE, [], faulty)} />)

    const banner = screen.getByTestId('vr-arm-fault')
    expect(banner.textContent).toContain('跟随服务报故障（2 条）')
    // sdk 版的两元组与 stm32 版的 flag 名
    expect(banner.textContent).toContain('J3: 5')
    expect(banner.textContent).toContain('FB_STALE')
  })

  it('健康的时候不出现故障条', () => {
    render(<VrLinkPanel vm={viewOf(SNAP_FOLLOWING)} />)

    expect(screen.queryByTestId('vr-arm-fault')).toBeNull()
  })

  it('连不上跟随服务时，把原因一并说出来', () => {
    const down = armStatus({ connected: false, error: 'TimeoutError: ' })
    render(<VrLinkPanel vm={viewOf(SNAP_FOLLOWING, CONSOLE_OFFLINE, [], down)} />)

    expect(screen.getByTestId('vr-arm-error').textContent).toContain('TimeoutError: ')
  })

  it('桥离线时不编原因', () => {
    render(<VrLinkPanel vm={offlineView()} />)

    expect(screen.queryByTestId('vr-arm-error')).toBeNull()
    expect(screen.queryByTestId('vr-arm-fault')).toBeNull()
  })
})

/**
 * 逐臂那一段：桥报几条臂就有几条，跟随态与故障各报各的。
 *
 * 双臂部署下"跟随中 / 持位"这种话必须能落到具体哪条臂上 —— 挤成一份会让人以为两条臂
 * 是同一个状态（其中一条停了、另一条还在动，这种局面现场是会有的）。
 */
describe('VR 链路卡 · 双臂', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('两条臂各报各的：身份、设备、跟随态、故障、错误都在自己那一段里', () => {
    const armA = armViewOf('armA', '/dev/ttyACM0')
    const armB = armViewOf('armB', 'can0', armStatus({
      state: 'holding',
      flags: ['FB_STALE'],
      error: 'TimeoutError: ',
    }))
    render(<VrLinkPanel vm={viewOf(SNAP_FOLLOWING, CONSOLE_OFFLINE, [armA, armB])} />)

    const rows = screen.getByTestId('vr-arm-rows')
    const [rowA, rowB] = Array.from(rows.children) as HTMLElement[]
    expect(rowA.textContent).toContain('armA')
    expect(rowA.textContent).toContain('/dev/ttyACM0')
    expect(rowA.textContent).toContain('following')
    expect(rowB.textContent).toContain('armB')
    expect(rowB.textContent).toContain('can0')
    expect(rowB.textContent).toContain('holding')
    // 出事的那条臂自己说，另一条不受牵连
    expect(rowA.textContent).not.toContain('FB_STALE')
    expect(rowB.textContent).toContain('故障 1 条')
    expect(rowB.textContent).toContain('FB_STALE')
    expect(rowB.textContent).toContain('TimeoutError: ')
  })

  it('双臂时不整张卡再报一遍故障（逐臂那一段已经说过了）', () => {
    const faulty = armStatus({ fault: [[3, 5]] })
    render(
      <VrLinkPanel
        vm={viewOf(SNAP_FOLLOWING, CONSOLE_OFFLINE, [
          armViewOf('armA', '/dev/ttyACM0', faulty),
          armViewOf('armB', 'can0'),
        ], faulty)}
      />,
    )

    expect(screen.queryByTestId('vr-arm-fault')).toBeNull()
    expect(screen.getByTestId('vr-arm-rows').textContent).toContain('J3: 5')
  })

  it('单臂部署不出逐臂那一段：整张卡本来就是它的', () => {
    const faulty = armStatus({ fault: [[3, 5]] })
    render(<VrLinkPanel vm={viewOf(SNAP_FOLLOWING, CONSOLE_OFFLINE,
      [armViewOf('armA', '/dev/ttyACM0', faulty)], faulty)} />)

    expect(screen.queryByTestId('vr-arm-rows')).toBeNull()
    // 同一条故障还是说出来，只是由整张卡的那条横幅说
    expect(screen.getByTestId('vr-arm-fault').textContent).toContain('J3: 5')
  })
})

/**
 * 桥版本护栏：契约哪天变了，页面得说出来，而不是静默少显示几样。
 */
describe('VR 链路卡 · 桥版本', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('对得上（含补丁号不同）就不吵', () => {
    render(<VrLinkPanel vm={viewOf({ bridge: { online: true, version: '0.1.7' } })} />)

    expect(screen.queryByTestId('vr-version-warning')).toBeNull()
    expect(screen.getByText('v0.1.7')).toBeTruthy()
  })

  it('minor 变了就挂一枚徽标，并在悬停里说清对着哪一版写的', () => {
    render(<VrLinkPanel vm={viewOf({ bridge: { online: true, version: '0.2.0' } })} />)

    const chip = screen.getByTestId('vr-version-warning')
    expect(chip.textContent).toBe('版本不匹配')
    expect(chip.getAttribute('title')).toContain('0.2.0')
    expect(chip.getAttribute('title')).toContain('0.1')
  })

  it('桥没报版本就什么都不说', () => {
    // 真固件就是没有 version 的那种（早起版本没发这个字段）
    render(<VrLinkPanel vm={viewOf(SNAP_FOLLOWING)} />)

    expect(screen.queryByTestId('vr-version-warning')).toBeNull()
  })
})
