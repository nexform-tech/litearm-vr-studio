import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import i18n from '@/i18n'
import { VrArmManifestPanel } from './VrArmManifestPanel'
import { readArmManifest, type ArmManifestRow, type ArmManifestView } from './useArmManifest'

/**
 * 臂映射卡：每样东西分开显示（桥认的口 / 谁定的 / 服务真正回的口），改动交给桥。
 *
 * 两条臂各两格口：**臂是串口、夹爪是 CAN**，两类不通用 —— 所以这里既钉判据（配反了不
 * 报错，任何一句"提示性"文案松掉就变成"两条臂对调着跑，界面上什么都看不出来"），也钉
 * 那两格各只列自己那一类候选。
 */

function row(over: Partial<ArmManifestRow> = {}): ArmManifestRow {
  return {
    arm: 'armA',
    side: 'left',
    device: '/dev/serial/by-id/usb-A',
    gripper: 'can0',
    source: 'record',
    confirmedAt: '2026-10-16T08:00:00+00:00',
    reported: '/dev/serial/by-id/usb-A',
    reportedGripper: 'can0',
    ...over,
  }
}

function viewOf(over: Partial<ArmManifestView> = {}): ArmManifestView {
  return {
    rows: [row()],
    ports: [],
    portsError: null,
    loadingPorts: false,
    saving: false,
    error: null,
    saved: null,
    canEdit: true,
    refreshPorts: vi.fn(),
    save: vi.fn(),
    dismissError: vi.fn(),
    ...over,
  }
}

/** 三种 `kind` 都给一份：用例要能看出"这一格只列自己那一类"。 */
beforeEach(() => {
  // Radix 的 Select 打开时会把当前项滚进视野；jsdom 没有这个方法（同 GripperPanel.test）。
  HTMLElement.prototype.scrollIntoView = () => {}
})

const ALL_PORTS = [
  { path: '/dev/serial/by-id/usb-A', kind: 'by-id' },
  { path: '/dev/serial/by-id/usb-B', kind: 'by-id' },
  { path: '/dev/ttyACM0', kind: 'serial' },
  { path: 'can0', kind: 'can' },
  { path: 'can1', kind: 'can' },
]

describe('VR 臂映射卡', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('一行一条臂：左右、身份、桥认的口与来源都写出来', () => {
    render(<VrArmManifestPanel v={viewOf({
      rows: [row(), row({ arm: 'armB', side: 'right', device: '/dev/serial/by-id/usb-B',
                          source: 'config', confirmedAt: '' })],
    })} />)

    expect(screen.getByText('左臂')).toBeTruthy()
    expect(screen.getByText('右臂')).toBeTruthy()
    expect(screen.getByText('armA')).toBeTruthy()
    // 来源分开说：操作员确认过的 ≠ 装机时写下的默认
    expect(screen.getByText('已确认')).toBeTruthy()
    expect(screen.getByText('装机默认')).toBeTruthy()
    // 列不出候选口时退回手填，当前值仍然看得见（不是空的）
    expect(screen.getByTestId('manifest-input-device-armA')).toHaveProperty(
      'value', '/dev/serial/by-id/usb-A')
    expect(screen.getByTestId('manifest-input-gripper-armA')).toHaveProperty('value', 'can0')
  })

  it('一路两格：臂那一格只列串口，夹爪那一格只列 CAN', () => {
    render(<VrArmManifestPanel v={viewOf({ ports: ALL_PORTS })} />)

    fireEvent.click(screen.getByTestId('manifest-select-device-armA'))
    const armOptions = screen.getAllByRole('option').map((el) => el.textContent)
    expect(armOptions).toContain('/dev/serial/by-id/usb-A（按设备序列号，推荐）')
    expect(armOptions).toContain('/dev/ttyACM0（拔插会变）')
    // 一个 CAN 口都不该出现在臂那一格里：挑中了这条臂也开不了它
    expect(armOptions.some((label) => label?.startsWith('can'))).toBe(false)
  })

  it('夹爪那一格只列 CAN，而且没有夹爪的臂根本不摆这一格', () => {
    render(<VrArmManifestPanel v={viewOf({
      rows: [row({ arm: 'armA' }), row({ arm: 'armB', side: 'right',
                                        gripper: '', reportedGripper: '' })],
      ports: ALL_PORTS,
    })} />)

    fireEvent.click(screen.getByTestId('manifest-select-gripper-armA'))
    const gripOptions = screen.getAllByRole('option').map((el) => el.textContent)
    expect(gripOptions).toEqual(['can0（CAN）', 'can1（CAN）'])
    // armB 在桥那边没有夹爪（`ARM_B_GRIP` 没配）：没有的东西没有口可指认，不给这一格
    expect(screen.queryByTestId('manifest-select-gripper-armB')).toBeNull()
    expect(screen.queryByTestId('manifest-input-gripper-armB')).toBeNull()
  })

  it('真机回的口与桥认的口不符：当场标出来', () => {
    render(<VrArmManifestPanel v={viewOf({
      rows: [row({ reported: '/dev/serial/by-id/usb-B' })],
    })} />)
    expect(screen.getByText(/跟随服务实际开的是 \/dev\/serial\/by-id\/usb-B/)).toBeTruthy()
  })

  it('夹爪服务回的口不符时同样标出来', () => {
    render(<VrArmManifestPanel v={viewOf({ rows: [row({ reportedGripper: 'can1' })] })} />)
    expect(screen.getByText(/夹爪服务实际报的是 can1/)).toBeTruthy()
  })

  it('两者一致时不出现那两行告警（否则它会天天亮着，没人再看）', () => {
    render(<VrArmManifestPanel v={viewOf()} />)
    expect(screen.queryByText(/跟随服务实际开的是/)).toBeNull()
    expect(screen.queryByText(/夹爪服务实际报的是/)).toBeNull()
  })

  it('改一个口 → 保存按钮才可用，送的是**改动过的那几条**', () => {
    const save = vi.fn()
    render(<VrArmManifestPanel v={viewOf({
      rows: [row(), row({ arm: 'armB', side: 'right', device: '/dev/serial/by-id/usb-B' })],
      save,
    })} />)

    const button = screen.getByRole('button', { name: '保存到桥' })
    expect(button).toHaveProperty('disabled', true)   // 没改就不给按

    fireEvent.change(screen.getByTestId('manifest-input-device-armA'), {
      target: { value: '/dev/ttyUSB0' },
    })
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)

    // 只送改动过的那条：没动的臂连提都不提 —— 送整份会把"卡片这边还旧着"的那条臂
    // 按卡片的值盖回去，而另一台上位机可能刚改过它。
    expect(save).toHaveBeenCalledWith({ armA: '/dev/ttyUSB0' }, {})
  })

  it('只改夹爪的口也一样能存，而且只送夹爪那张表', () => {
    const save = vi.fn()
    render(<VrArmManifestPanel v={viewOf({ save })} />)

    fireEvent.change(screen.getByTestId('manifest-input-gripper-armA'), {
      target: { value: 'can1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存到桥' }))

    // 串口那条一个字节都没动 ⇒ 不进 `devices`（桥那边会把两样口写进同一条记录）
    expect(save).toHaveBeenCalledWith({}, { armA: 'can1' })
  })

  it('把改动撤回去之后，上一次的拒绝不再挂在屏幕上', () => {
    const dismissError = vi.fn()
    render(<VrArmManifestPanel v={viewOf({
      error: '同一个 CAN 口被指给了两个夹爪（can1）',
      dismissError,
    })} />)
    // 卡片这会儿与桥一致（没有待存的东西）⇒ 那句话说的是上一个尝试，收起来
    expect(dismissError).toHaveBeenCalled()
  })

  it('桥拒绝时显示桥的原话（不是"保存失败"）', () => {
    render(<VrArmManifestPanel v={viewOf({
      error: 'teleop 正在运行：命令行里的串口是**启动那一刻冻下来的**',
    })} />)
    expect(screen.getByText(/teleop 正在运行/)).toBeTruthy()
  })

  it('正在遥操时不给改，并说明为什么', () => {
    render(<VrArmManifestPanel v={viewOf({ canEdit: false })} />)
    expect(screen.getByRole('button', { name: '保存到桥' })).toHaveProperty('disabled', true)
    expect(screen.getByTestId('manifest-input-device-armA')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('manifest-input-gripper-armA')).toHaveProperty('disabled', true)
    expect(screen.getByText(/正在遥操/)).toBeTruthy()
  })

  it('保存成功后给出回执，并说明改的是哪条臂', () => {
    render(<VrArmManifestPanel v={viewOf({ saved: ['armA'] })} />)
    expect(screen.getByText('已保存：armA')).toBeTruthy()
  })

  it('候选口列不出来时：保留手填，并把原因说出来', () => {
    render(<VrArmManifestPanel v={viewOf({
      portsError: '本地程序未连接',
    })} />)
    expect(screen.getByText(/本地程序未连接/)).toBeTruthy()
    expect(screen.getByTestId('manifest-input-device-armA')).toBeTruthy()
  })

  it('候选口可用时用下拉，并把当前值也列进去', () => {
    render(<VrArmManifestPanel v={viewOf({ ports: ALL_PORTS })} />)

    // 不是手填框
    expect(screen.queryByTestId('manifest-input-device-armA')).toBeNull()
    const armRow = screen.getByTestId('manifest-select-device-armA')
    expect(within(armRow).getByText('/dev/serial/by-id/usb-A（按设备序列号，推荐）')).toBeTruthy()
  })

  it('桥还没认到臂时说明白，不摆一条空行', () => {
    render(<VrArmManifestPanel v={viewOf({ rows: [] })} />)
    expect(screen.getByText(/桥还没认到任何一条臂/)).toBeTruthy()
  })
})

describe('臂映射行 · 从帧里读', () => {
  it('桥认的两个口来自快照的 arm 段，服务回的两个口来自 vr_arm / vr_grip —— 分开取', () => {
    const rows = readArmManifest({
      arms: ['armA', 'armB'],
      snapshotFor: (arm) => (arm === 'armA'
        ? { arm: { side: 'left', device: '/dev/serial/by-id/usb-A', gripper: 'can0',
                   device_source: 'record', device_confirmed_at: '2026-10-16T08:00:00+00:00' } }
        : null),
      armStateFor: (arm) => (arm === 'armA' ? { device: '/dev/serial/by-id/usb-A' } : null),
      gripStateFor: (arm) => (arm === 'armA' ? { device: 'can0' } : null),
    })
    expect(rows).toEqual([
      { arm: 'armA', side: 'left', device: '/dev/serial/by-id/usb-A', gripper: 'can0',
        source: 'record', confirmedAt: '2026-10-16T08:00:00+00:00',
        reported: '/dev/serial/by-id/usb-A', reportedGripper: 'can0' },
      // 一个字节都没收到过的臂：整行空着，不编一个口出来
      { arm: 'armB', side: '', device: '', gripper: '', source: '', confirmedAt: '',
        reported: '', reportedGripper: '' },
    ])
  })
})
