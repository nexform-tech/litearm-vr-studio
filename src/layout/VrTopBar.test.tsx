import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

/**
 * VR 页的顶栏只放页面别处说不了的那一件事：上位机正在驱动机械臂。
 *
 * 所以这里既钉"有什么"（在动会亮），也钉"没有什么"——控制页那几个控制、桥的在线状态
 * 与版本（那些归下面链路卡说，说两遍会让人怀疑它们不是一个意思），以及**桥地址输入框**
 * （2026-10-15 起页面不再自己连桥：地址归 daemon 那台机器的配置，操作员没有可填的东西）。
 */
afterEach(cleanup)

const mocks = vi.hoisted(() => ({
  pathname: { current: '/vr' as string },
  status: { current: 'disconnected' as string },
  conn: { current: null as Record<string, unknown> | null },
  motionBusy: { current: false },
  robotState: { current: null as string | null },
}))

vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: mocks.pathname.current }) }))

vi.mock('@/lib/arm', () => ({
  useArmConnection: () => ({
    status: mocks.status.current,
    conn: mocks.conn.current,
    motionBusy: mocks.motionBusy.current,
  }),
  useArmPorts: () => ({ ports: [], loading: false, error: null, reload: vi.fn() }),
  useArmState: () => null,
  armClient: {
    subscribeState: () => () => {},
    get state() {
      return mocks.robotState.current ? { state: mocks.robotState.current } : null
    },
  },
}))

const { TopBar } = await import('./TopBar')

const activityChip = () => screen.queryByTestId('vr-topbar-console-activity')

beforeEach(async () => {
  mocks.pathname.current = '/vr'
  mocks.status.current = 'disconnected'
  mocks.conn.current = null
  mocks.motionBusy.current = false
  mocks.robotState.current = null
  await i18n.changeLanguage('zh')
})

describe('VR 页顶栏', () => {
  it('写的是 VR 页的标题，控制页那几个控制一个都不在', () => {
    render(<TopBar />)

    expect(screen.getByText('VR 遥操控制台')).toBeTruthy()
    // 串口下拉、连接、断开：这些是"本控制台驱动哪台设备"，与 VR 链路无关
    expect(document.getElementById('topbar-port')).toBeNull()
    expect(document.getElementById('topbar-connect-btn')).toBeNull()
    expect(document.getElementById('topbar-disconnect-btn')).toBeNull()
    // 顶栏上**只有一颗**按钮：桥的配置面收在右上角（`VrConfigDialog`，点开是表单）。
    // 地址仍然不填（归 daemon），动作按钮仍然在控制卡上 —— 这一条守的是那两件事。
    const buttons = screen.queryAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.getAttribute('data-testid')).toBe('vr-topbar-config')
  })

  it('桥地址不再是个输入项（页面不自己连桥）', () => {
    render(<TopBar />)

    expect(screen.queryByLabelText('桥地址')).toBeNull()
    expect(screen.queryByText('应用')).toBeNull()
  })

  it('桥的在线状态与版本不在这里说（那是链路卡的事）', () => {
    render(<TopBar />)

    for (const word of ['已连接', '未连接', '未设置']) {
      expect(screen.queryByText(word)).toBeNull()
    }
    expect(screen.queryByText(/^v\d/)).toBeNull()
  })

  it('上位机闲着的时候不挂任何标签', () => {
    mocks.status.current = 'connected'
    mocks.conn.current = { port: '/dev/ttyACM0' }
    render(<TopBar />)

    expect(activityChip()).toBeNull()
  })

  it('上位机在动的时候才亮一颗，且写明是谁在动', () => {
    mocks.status.current = 'connected'
    mocks.conn.current = { port: '/dev/ttyACM0' }
    mocks.robotState.current = 'moving'
    render(<TopBar />)

    expect(activityChip()?.textContent).toBe('上位机在动')
    // 悬停里说明具体在干什么（复用控制卡那套文案）
    expect(activityChip()?.getAttribute('title')).toBe('正在执行运动指令')
  })
})

describe('顶栏的分派', () => {
  it('控制页仍然是原来那条：有连接按钮', () => {
    mocks.pathname.current = '/control'
    render(<TopBar />)

    expect(screen.getByText('机械臂控制台')).toBeTruthy()
    expect(document.getElementById('topbar-connect-btn')).toBeTruthy()
    expect(screen.queryByLabelText('桥地址')).toBeNull()
  })

  it('titleMap 里没有的路径落到控制页那条，而不是 VR 那条', () => {
    mocks.pathname.current = '/'
    render(<TopBar />)

    expect(screen.getByText('机械臂控制台')).toBeTruthy()
    expect(screen.queryByLabelText('桥地址')).toBeNull()
  })
})
