import type { VrBridgeSnapshot } from './vrTypes'

/**
 * litearm-vr-bridge 客户端。
 *
 * 只做一件事：连上桥的 `/ws/status`，维护最新快照、连接状态与自动重连。
 * 连不上就如实报"离线"，页面显示空态（没有兜底数据，见 vrLink.ts）。
 *
 * 桥端契约见 litearm-vr-bridge/docs/DESIGN.md。
 */

const LS_KEY = 'vr_bridge_endpoint'
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]
/** 超过这个时间没收到快照即视为断线（桥按 10Hz 推送） */
const STALE_MS = 3000

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function readSavedEndpoint(): string {
  try {
    return normalizeEndpoint(localStorage.getItem(LS_KEY) ?? '')
  } catch {
    return ''
  }
}

/**
 * 桥地址：本地保存值 → 打包注入的默认值 → 空（未配置）。
 *
 * ⚠ 这里**故意没有**内置默认值，两条理由：
 *
 *   1. 地址本就是现场相关的。遥操场景里桥跑在机械臂那台机器上（STM32 的 USB 线插在
 *      谁身上，跟随服务就在谁那儿），每次装机都不同，默认值猜不出来。
 *   2. 内置默认值一旦猜错，错法是最坏的那种：**静默**。早先这里写死的是
 *      `ws://localhost:8765/ws/status`，而 studio 守护进程当时也用 8765，于是打包版里
 *      这个地址必然打到自己的 daemon 上（FastAPI 对未知的 WS 路径回 403），页面一声
 *      不吭地退回演示数据——看着像"连上了"，其实一个真实字节都没进来。
 *      （守护进程后来挪到了 49321，见 daemon 的 `DEFAULT_HTTP_PORT`，但这个教训与
 *      端口号无关：宁可空着让操作员填，也不给一个可能悄悄打错的默认值。）
 *
 * 打包时想固定地址就用 `VITE_VR_BRIDGE_ENDPOINT` 注入，那是明确配置过的。
 */
export function getInitialBridgeEndpoint(): string {
  const baked = normalizeEndpoint((import.meta.env.VITE_VR_BRIDGE_ENDPOINT as string | undefined) ?? '')
  return readSavedEndpoint() || baked
}

export function setBridgeEndpoint(endpoint: string) {
  const value = normalizeEndpoint(endpoint)
  try {
    if (value) localStorage.setItem(LS_KEY, value)
    else localStorage.removeItem(LS_KEY)
  } catch {
    /* 读不到 localStorage 时只在本次会话生效 */
  }
  vrBridge.switchEndpoint(value)
}

class VrBridgeClient {
  private ws: WebSocket | null = null
  private endpointValue = getInitialBridgeEndpoint()
  private onlineValue = false
  private snapshotValue: VrBridgeSnapshot | null = null
  private lastMessageAt = 0
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private staleTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private listeners = new Set<() => void>()

  get endpoint(): string {
    return this.endpointValue
  }

  /** 配过桥地址没有。没配过就不去连：页面该显示"未设置"而不是"连不上"。 */
  get configured(): boolean {
    return this.endpointValue !== ''
  }

  get online(): boolean {
    return this.onlineValue
  }

  get snapshot(): VrBridgeSnapshot | null {
    return this.snapshotValue
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  start = () => {
    if (this.running) return
    this.running = true
    if (this.endpointValue) this.connect()
    this.staleTimer = setInterval(this.checkStale, 1000)
  }

  stop = () => {
    if (!this.running) return
    this.running = false
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer)
      this.staleTimer = null
    }
    this.closeSocket()
    this.markOnline(false)
  }

  /** 切换桥地址：断开当前连接，用新地址重连（清空地址＝停止连接） */
  switchEndpoint = (endpoint: string) => {
    this.endpointValue = normalizeEndpoint(endpoint)
    this.attempt = 0
    this.closeSocket()
    this.markOnline(false)
    if (!this.running || !this.endpointValue) return
    this.connect()
  }

  /**
   * 向桥发一个动作（teleop.start / teleop.stop / estop / process.*）。
   * 返回是否成功送出——桥不在时调用方应保持按钮禁用。
   */
  sendAction = (action: string, payload?: Record<string, unknown>): boolean => {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify({ action, ...payload }))
      return true
    } catch {
      return false
    }
  }

  private closeSocket() {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    try {
      ws.close()
    } catch {
      /* 忽略关闭异常 */
    }
  }

  private connect = () => {
    if (!this.running || !this.endpointValue) return
    this.closeSocket()

    let ws: WebSocket
    try {
      ws = new WebSocket(this.endpointValue)
    } catch {
      this.scheduleRetry()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this.lastMessageAt = performance.now()
      this.markOnline(true)
    }
    ws.onmessage = (ev) => {
      this.lastMessageAt = performance.now()
      try {
        this.snapshotValue = JSON.parse(String(ev.data)) as VrBridgeSnapshot
      } catch {
        return // 坏帧丢弃，不杀连接
      }
      this.notify()
    }
    ws.onerror = () => {
      this.markOnline(false)
    }
    ws.onclose = () => {
      this.ws = null
      this.markOnline(false)
      this.scheduleRetry()
    }
  }

  private scheduleRetry() {
    if (!this.running || this.retryTimer) return
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]
    this.attempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private checkStale = () => {
    if (!this.onlineValue) return
    if (performance.now() - this.lastMessageAt > STALE_MS) {
      this.markOnline(false)
      this.scheduleRetry()
    }
  }

  private markOnline(online: boolean) {
    if (this.onlineValue === online) return
    this.onlineValue = online
    if (!online) this.snapshotValue = null
    this.notify()
  }

  private notify() {
    for (const cb of this.listeners) cb()
  }
}

export const vrBridge = new VrBridgeClient()
