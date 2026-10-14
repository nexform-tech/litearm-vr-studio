import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getInitialBridgeEndpoint, vrBridge } from './vrBridgeClient'

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
