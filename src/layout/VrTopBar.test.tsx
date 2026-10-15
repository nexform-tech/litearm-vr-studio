import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

/**
 * VR 页的顶栏只放页面别处说不了的两件事：桥地址、上位机正在驱动机械臂。
 *
 * 所以这里既钉"有什么"（地址可填、在动会亮），也钉"没有什么"——控制页那几个控制，
 * 以及桥的在线状态与版本（那两样归下面链路卡说，说两遍会让人怀疑它们不是一个意思）。
 */
afterEach(cleanup)

const mocks = vi.hoisted(() => ({
  pathname: { current: '/vr' as string },
  status: { current: 'disconnected' as string },
  conn: { current: null as Record<string, unknown> | null },
  motionBusy: { current: false },
  robotState: { current: null as string | null },
  bridge: { endpoint: '' },
  setBridgeEndpoint: vi.fn((value: string) => {
    // 真的那个会归一化、存本机并重连；这里只模拟"客户端记住了新地址"。
    mocks.bridge.endpoint = value.trim().replace(/\/+$/, '')
  }),
}))

vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: mocks.pathname.current }) }))

vi.mock('@/features/vr/vrBridgeClient', () => ({
  vrBridge: mocks.bridge,
  setBridgeEndpoint: mocks.setBridgeEndpoint,
}))

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

const addressInput = () => screen.getByLabelText('桥地址') as HTMLInputElement
const activityChip = () => screen.queryByTestId('vr-topbar-console-activity')

beforeEach(async () => {
  mocks.pathname.current = '/vr'
  mocks.status.current = 'disconnected'
  mocks.conn.current = null
  mocks.motionBusy.current = false
  mocks.robotState.current = null
  mocks.bridge.endpoint = ''
  mocks.setBridgeEndpoint.mockClear()
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
    // 这一页唯一的按钮是「应用」（填桥地址）
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe('应用')
  })

  it('桥的在线状态与版本不在这里说（那是链路卡的事）', () => {
    render(<TopBar />)

    for (const word of ['已连接', '未连接', '未设置']) {
      expect(screen.queryByText(word)).toBeNull()
    }
    expect(screen.queryByText(/^v\d/)).toBeNull()
  })

  it('配过地址就把地址摆在输入框里，没配过就只有占位符', () => {
    render(<TopBar />)
    expect(addressInput().value).toBe('')

    cleanup()
    mocks.bridge.endpoint = 'ws://192.168.31.139:8765/ws/status'
    render(<TopBar />)
    expect(addressInput().value).toBe('ws://192.168.31.139:8765/ws/status')
  })

  it('点「应用」把它交给客户端去存并重连', () => {
    render(<TopBar />)

    fireEvent.change(addressInput(), { target: { value: 'ws://192.168.31.139:8765/ws/status/' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))

    expect(mocks.setBridgeEndpoint).toHaveBeenCalledWith('ws://192.168.31.139:8765/ws/status/')
    // 显示的是客户端归一化之后真正存下的那个（去尾斜杠）
    expect(addressInput().value).toBe('ws://192.168.31.139:8765/ws/status')
  })

  it('回车与点「应用」是同一件事', () => {
    render(<TopBar />)

    fireEvent.change(addressInput(), { target: { value: 'ws://10.0.0.2:8765/ws/status' } })
    fireEvent.keyDown(addressInput(), { key: 'Enter' })

    expect(mocks.setBridgeEndpoint).toHaveBeenCalledWith('ws://10.0.0.2:8765/ws/status')
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
