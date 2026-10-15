import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getInitialBridgeEndpoint, setBridgeEndpoint, vrBridge } from './vrBridgeClient'

/**
 * 桥地址的默认值。
 *
 * 这一条是"VR 页数据全是假的"那件事的根因留下的规矩：页面早先内置了
 * `ws://localhost:8765/ws/status`，而那个地址在当时必然打到 studio 自己的守护进程上
 * （它也监听 8765），WS 握手被拒后页面静默退回演示数据。所以这里钉住两件事：
 * **没有**内置默认值；地址为空时**不去连**。
 */

const LS_KEY = 'vr_bridge_endpoint'

describe('桥地址默认值', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('没存过、也没打包注入时就是空 —— 不猜一个地址', () => {
    expect(getInitialBridgeEndpoint()).toBe('')
  })

  it('存过的地址优先，并去掉尾斜杠', () => {
    localStorage.setItem(LS_KEY, 'ws://192.168.31.139:8765/ws/status/')
    expect(getInitialBridgeEndpoint()).toBe('ws://192.168.31.139:8765/ws/status')
  })

  it('没配地址时不去连（不会构造 WebSocket）', () => {
    const ctor = vi.fn()
    vi.stubGlobal('WebSocket', ctor)

    // 单例在模块加载时就取了初始地址，这里把它切回空值再启动
    vrBridge.switchEndpoint('')
    vrBridge.start()
    vrBridge.stop()

    expect(vrBridge.configured).toBe(false)
    expect(ctor).not.toHaveBeenCalled()
  })
})

/**
 * 存地址这一手（页面上那个输入框走的就是它）。
 *
 * 归一化在**存的时候**做：操作员从别处粘来的地址常带尾斜杠或前后空格，存进去的是
 * 真正会用的那一个，下次开机读到的也就是它。
 */
describe('setBridgeEndpoint', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
    vrBridge.switchEndpoint('')
  })

  it('存的是去掉空白与尾斜杠的那个', () => {
    setBridgeEndpoint('  ws://192.168.31.139:8765/ws/status/  ')
    expect(localStorage.getItem(LS_KEY)).toBe('ws://192.168.31.139:8765/ws/status')
    expect(vrBridge.endpoint).toBe('ws://192.168.31.139:8765/ws/status')
  })

  it('清空 = 删掉这一项，也等于"不去连任何地址"', () => {
    localStorage.setItem(LS_KEY, 'ws://192.168.31.139:8765/ws/status')
    setBridgeEndpoint('')

    expect(localStorage.getItem(LS_KEY)).toBeNull()
    expect(vrBridge.configured).toBe(false)
  })
})
