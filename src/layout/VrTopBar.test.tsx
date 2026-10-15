import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

/**
 * 顶栏在 VR 页上是另一副内容：只报两条链路的通断，**一个控制都不给**。
 *
 * 这里钉两件事：控制页那条的控制件在 /vr 上真的不见了（不是被 CSS 藏了），
 * 以及桥/上位机两条链路各自的读数取自哪里、未配置时怎么说。
 */
afterEach(cleanup)

const mocks = vi.hoisted(() => ({
  pathname: { current: '/vr' as string },
  status: { current: 'disconnected' as string },
  conn: { current: null as Record<string, unknown> | null },
  motionBusy: { current: false },
  robotState: { current: null as string | null },
  bridge: {
    online: false,
    configured: false,
    endpoint: '',
    snapshot: null as unknown,
    subscribe: () => () => {},
  },
}))

vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: mocks.pathname.current }) }))

vi.mock('@/features/vr/vrBridgeClient', () => ({ vrBridge: mocks.bridge }))

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

const bridgeCell = () => within(screen.getByTestId('vr-topbar-bridge'))
const consoleCell = () => within(screen.getByTestId('vr-topbar-console'))

beforeEach(async () => {
  mocks.pathname.current = '/vr'
  mocks.status.current = 'disconnected'
  mocks.conn.current = null
  mocks.motionBusy.current = false
  mocks.robotState.current = null
  mocks.bridge.online = false
  mocks.bridge.configured = false
  mocks.bridge.endpoint = ''
  mocks.bridge.snapshot = null
  await i18n.changeLanguage('zh')
})

describe('VR 页顶栏', () => {
  it('写的是 VR 页的标题，且控制页那几个控制一个都不在', () => {
    render(<TopBar />)

    expect(screen.getByText('VR 遥操控制台')).toBeTruthy()
    // 串口下拉、连接、断开：这些都是"本控制台驱动哪台设备"，与 VR 链路无关
    expect(document.getElementById('topbar-port')).toBeNull()
    expect(document.getElementById('topbar-connect-btn')).toBeNull()
    expect(document.getElementById('topbar-disconnect-btn')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('桥没配过地址时说「未设置」，不说「未连接」', () => {
    render(<TopBar />)

    expect(bridgeCell().getByText('未设置')).toBeTruthy()
    expect(bridgeCell().queryByText('未连接')).toBeNull()
  })

  it('桥配过且在线时，地址与版本都在', () => {
    mocks.bridge.configured = true
    mocks.bridge.online = true
    mocks.bridge.endpoint = 'ws://192.168.31.139:8765/ws/status'
    mocks.bridge.snapshot = { bridge: { version: '0.1.0' } }
    render(<TopBar />)

    expect(bridgeCell().getByText('已连接')).toBeTruthy()
    expect(bridgeCell().getByText('ws://192.168.31.139:8765/ws/status')).toBeTruthy()
    expect(bridgeCell().getByText('v0.1.0')).toBeTruthy()
  })

  it('上位机链路连着时给端口，没连时只说未连接', () => {
    mocks.status.current = 'connected'
    mocks.conn.current = { port: '/dev/ttyACM0' }
    render(<TopBar />)

    expect(consoleCell().getByText('已连接')).toBeTruthy()
    expect(consoleCell().getByText('/dev/ttyACM0')).toBeTruthy()
  })

  it('上位机在动的时候才挂那颗「在动」', () => {
    mocks.status.current = 'connected'
    mocks.conn.current = { port: '/dev/ttyACM0' }
    render(<TopBar />)
    expect(screen.queryByTestId('vr-topbar-console-activity')).toBeNull()

    cleanup()
    mocks.robotState.current = 'moving'
    render(<TopBar />)
    expect(screen.getByTestId('vr-topbar-console-activity').textContent).toContain('在动')
  })
})

describe('顶栏的分派', () => {
  it('控制页仍然是原来那条：有连接按钮', () => {
    mocks.pathname.current = '/control'
    render(<TopBar />)

    expect(screen.getByText('机械臂控制台')).toBeTruthy()
    expect(document.getElementById('topbar-connect-btn')).toBeTruthy()
    expect(screen.queryByTestId('vr-topbar-bridge')).toBeNull()
  })

  it('titleMap 里没有的路径落到控制页那条，而不是 VR 那条', () => {
    mocks.pathname.current = '/'
    render(<TopBar />)

    expect(screen.getByText('机械臂控制台')).toBeTruthy()
    expect(screen.queryByTestId('vr-topbar-bridge')).toBeNull()
  })
})
