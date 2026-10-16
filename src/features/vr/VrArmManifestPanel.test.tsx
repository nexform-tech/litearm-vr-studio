import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { VrArmManifestPanel } from './VrArmManifestPanel'
import { readArmManifest, type ArmManifestRow, type ArmManifestView } from './useArmManifest'

/**
 * 臂映射卡：三样东西分开显示（桥认的口 / 谁定的 / 真机回的口），改动交给桥。
 *
 * 这里钉住的是**判据**，不是排版：配反了不报错，所以这张卡上任何一句"提示性"文案
 * 松掉，现场就变成"两条臂对调着跑，界面上什么都看不出来"。
 */

function row(over: Partial<ArmManifestRow> = {}): ArmManifestRow {
  return {
    arm: 'armA',
    side: 'left',
    device: '/dev/serial/by-id/usb-A',
    source: 'record',
    confirmedAt: '2026-10-16T08:00:00+00:00',
    reported: '/dev/serial/by-id/usb-A',
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
    ...over,
  }
}

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
    expect(screen.getByTestId('manifest-input-armA')).toHaveProperty(
      'value', '/dev/serial/by-id/usb-A')
  })

  it('真机回的口与桥认的口不符：当场标出来', () => {
    render(<VrArmManifestPanel v={viewOf({
      rows: [row({ reported: '/dev/serial/by-id/usb-B' })],
    })} />)
    expect(screen.getByText(/跟随服务实际开的是 \/dev\/serial\/by-id\/usb-B/)).toBeTruthy()
  })

  it('两者一致时不出现那行告警（否则它会天天亮着，没人再看）', () => {
    render(<VrArmManifestPanel v={viewOf()} />)
    expect(screen.queryByText(/跟随服务实际开的是/)).toBeNull()
  })

  it('改一个口 → 保存按钮才可用，保存的是**整份**映射', () => {
    const save = vi.fn()
    render(<VrArmManifestPanel v={viewOf({
      rows: [row(), row({ arm: 'armB', side: 'right', device: '/dev/serial/by-id/usb-B' })],
      save,
    })} />)

    const button = screen.getByRole('button', { name: '保存到桥' })
    expect(button).toHaveProperty('disabled', true)   // 没改就不给按

    fireEvent.change(screen.getByTestId('manifest-input-armA'), {
      target: { value: '/dev/ttyUSB0' },
    })
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)

    // 只改了一条，但送的是整份：桥那边的记录永远与这台机器的臂清单一致
    expect(save).toHaveBeenCalledWith({
      armA: '/dev/ttyUSB0',
      armB: '/dev/serial/by-id/usb-B',
    })
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
    expect(screen.getByTestId('manifest-input-armA')).toHaveProperty('disabled', true)
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
    expect(screen.getByTestId('manifest-input-armA')).toBeTruthy()
  })

  it('候选口可用时用下拉，并把当前值也列进去', () => {
    render(<VrArmManifestPanel v={viewOf({
      ports: [
        { path: '/dev/serial/by-id/usb-A', kind: 'by-id' },
        { path: '/dev/serial/by-id/usb-B', kind: 'by-id' },
      ],
    })} />)
    // 不是手填框
    expect(screen.queryByTestId('manifest-input-armA')).toBeNull()
    expect(screen.getByText('/dev/serial/by-id/usb-A（按设备序列号，推荐）')).toBeTruthy()
  })

  it('桥还没认到臂时说明白，不摆一条空行', () => {
    render(<VrArmManifestPanel v={viewOf({ rows: [] })} />)
    expect(screen.getByText(/桥还没认到任何一条臂/)).toBeTruthy()
  })
})

describe('臂映射行 · 从帧里读', () => {
  it('桥认的口来自快照的 arm 段，真机回的口来自 vr_arm —— 两者分开取', () => {
    const rows = readArmManifest({
      arms: ['armA', 'armB'],
      snapshotFor: (arm) => (arm === 'armA'
        ? { arm: { side: 'left', device: '/dev/serial/by-id/usb-A',
                   device_source: 'record', device_confirmed_at: '2026-10-16T08:00:00+00:00' } }
        : null),
      armStateFor: (arm) => (arm === 'armA' ? { device: '/dev/serial/by-id/usb-A' } : null),
    })
    expect(rows).toEqual([
      { arm: 'armA', side: 'left', device: '/dev/serial/by-id/usb-A',
        source: 'record', confirmedAt: '2026-10-16T08:00:00+00:00',
        reported: '/dev/serial/by-id/usb-A' },
      // 一个字节都没收到过的臂：整行空着，不编一个口出来
      { arm: 'armB', side: '', device: '', source: '', confirmedAt: '', reported: '' },
    ])
  })
})
