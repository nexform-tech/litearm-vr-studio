import { vrBridge } from './vrDaemonClient'
import type { VrArmSource, VrBridgeSnapshot, VrLinkSnapshot, VrLinkState } from './vrTypes'

/**
 * VR 页的数据编排层：**唯一**对外暴露的取数口。
 *
 * 只有一个数据源：litearm-vr-bridge 的 `/ws/status`。桥连不上时页面显示空态，
 * 不拿任何本地编造的数据顶上 —— 这一页的每个数字都可能是操作员据以判断"机械臂
 * 现在在不在动"的依据，假数据比没有数据危险得多。
 *
 * 真实链路（见 litearm-vr-bridge/docs/DESIGN.md）：
 *   头显 → 桥 :8765 → metavr（pybullet 逆解）→ TCP 9001 → arm_follow_server → 真机
 *
 * 两条前提别忘：
 *   1. 控制回路不在上位机里。手柄帧 90Hz 一帧帧过来，绕上位机一圈就会多一跳延迟。
 *   2. 这一页只做「看状态 + 按开关」，不参与解算与下发。
 *
 * 桥推来的字段比页面需要的多得多（见 `__fixtures__/bridgeSnapshots.ts` 的真实固件），
 * 映射逻辑集中在 `mapBridgeSnapshot`（纯函数，可直接单测）。
 */

const TICK_MS = 16
/** React 侧（数值卡片/关节角）的刷新间隔，与 3D 的 16ms 通道分开 */
const UI_NOTIFY_MS = 200
/** 判定"关节角变了"的阈值，避免浮点噪声造成无意义重绘 */
const Q_EPSILON = 1e-4

type Listener = () => void
type PoseListener = (q: number[]) => void

/** 页面字段里除 q 之外的部分（q 走 3D 视口的高频通道，单独通知） */
export type VrBridgeFields = Omit<VrLinkSnapshot, 'q'>

function finite(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function optionalMs(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 桥那边的真实来源（跟随服务 / 控制器）都算真机 */
function sourceOf(value: unknown): VrArmSource {
  return value === 'follow_server' || value === 'controller' ? 'real' : 'sim'
}

/**
 * 一条故障码 → 一句话。
 *
 * ⚠ 两种形状都认，因为两个版本的跟随服务报的不是一回事（见 bridge 的
 * `docs/FOLLOW-SERVER-COMPAT.md`）：sdk 版是 `[joint, err]`，stm32 版是 flag 名字串
 * （`FB_STALE` / `WD_TRIPPED` …）。认不出来的一律原样显示 —— 让操作员看到服务真正报的
 * 那个东西，比看到我们编的一句翻译有用（顶栏那三块状态也是这个口径）。
 */
export function formatArmFault(entry: unknown): string {
  if (Array.isArray(entry)) {
    const [joint, err] = entry as [unknown, unknown]
    return `J${String(joint)}: ${String(err)}`
  }
  return String(entry)
}

const LINK_STATES: readonly VrLinkState[] = ['idle', 'following', 'latched', 'fallback']

function linkStateOf(value: unknown, fallback: VrLinkState): VrLinkState {
  return LINK_STATES.includes(value as VrLinkState) ? (value as VrLinkState) : fallback
}

/** 桥离线时的基线：所有字段都是空态，页面照实显示"未连接" */
export function emptyBridgeFields(): VrBridgeFields {
  return {
    headsetOnline: false,
    headsetConnected: false,
    following: false,
    grip: false,
    tracked: false,
    fps: 0,
    latencyMs: 0,
    latencyEstimated: false,
    sinceFrameMs: 0,
    frames: 0,
    framesForwarded: 0,
    framesDropped: 0,
    framesBlocked: 0,
    bridgeOnline: false,
    bridgeVersion: '',
    bridgeUptimeS: 0,
    forwardCostMs: 0,
    forwardCostMaxMs: 0,
    metavrConnected: false,
    statusClients: 0,
    linkState: 'idle',
    linkEnabled: true,
    forwardEnabled: true,
    rearmRequired: false,
    fallbackActive: false,
    fallbackReason: null,
    fallbackGuardEnabled: true,
    warnMs: 200,
    fallbackMs: 500,
    armSource: 'sim',
    armConnected: false,
    armState: null,
    armError: null,
    armLastOkMs: null,
    armFault: null,
    owner: 'none',
  }
}

/** 把桥的一份快照映射成页面字段；缺字段一律退默认，不让页面崩。 */
export function mapBridgeSnapshot(snapshot: VrBridgeSnapshot): {
  fields: VrBridgeFields
  q: number[] | null
} {
  const headset = snapshot.headset ?? {}
  const arm = snapshot.arm ?? {}
  const bridge = snapshot.bridge ?? {}
  const link = snapshot.link ?? {}
  const fallback = snapshot.fallback ?? {}

  const rawQ = arm.q
  const q =
    Array.isArray(rawQ) && rawQ.length === 7 && rawQ.every((v) => Number.isFinite(Number(v)))
      ? rawQ.map(Number)
      : null

  return {
    fields: {
      headsetOnline: Boolean(headset.online),
      headsetConnected: Boolean(headset.connected),
      following: Boolean(headset.following),
      grip: Boolean(headset.grip),
      tracked: Boolean(headset.tracked),
      fps: finite(headset.fps),
      latencyMs: finite(headset.latency_ms),
      latencyEstimated: Boolean(headset.latency_estimated),
      sinceFrameMs: Math.round(finite(headset.last_frame_age_ms)),
      frames: Math.round(finite(headset.frames)),
      framesForwarded: Math.round(finite(headset.frames_forwarded)),
      framesDropped: Math.round(finite(headset.frames_dropped)),
      framesBlocked: Math.round(finite(headset.frames_blocked)),
      bridgeOnline: Boolean(bridge.online),
      bridgeVersion: asString(bridge.version),
      bridgeUptimeS: finite(bridge.uptime_s),
      forwardCostMs: finite(bridge.forward_cost_ms),
      forwardCostMaxMs: finite(bridge.forward_cost_max_ms),
      metavrConnected: Boolean(bridge.metavr_connected),
      statusClients: Math.round(finite(bridge.clients?.status)),
      linkState: linkStateOf(link.state, headset.following ? 'following' : 'idle'),
      linkEnabled: link.enabled ?? true,
      forwardEnabled: link.forward_enabled ?? true,
      rearmRequired: Boolean(link.rearm_required),
      fallbackActive: Boolean(fallback.active),
      fallbackReason: typeof fallback.reason === 'string' ? fallback.reason : null,
      fallbackGuardEnabled: fallback.guard_enabled ?? true,
      warnMs: finite(link.warn_ms, 200),
      fallbackMs: finite(link.fallback_ms, 500),
      armSource: sourceOf(arm.source),
      armConnected: Boolean(arm.connected),
      armState: typeof arm.state === 'string' ? arm.state : null,
      armError: typeof arm.error === 'string' ? arm.error : null,
      armLastOkMs: optionalMs(arm.last_ok_age_ms),
      armFault: Array.isArray(arm.fault) ? arm.fault : null,
      owner: asString(snapshot.owner, 'none'),
    },
    q,
  }
}

function qChanged(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i] - b[i]) > Q_EPSILON) return true
  }
  return false
}

class VrLink {
  private fields: VrBridgeFields = emptyBridgeFields()
  /** 桥报过的最后一组关节角；一个真实字节都没收到过时是 null */
  private q: number[] | null = null
  private cached: VrLinkSnapshot = { ...this.fields, q: null }
  private tickTimer: number | null = null
  private lastTickAt = 0
  private lastNotifyAt = 0
  private unsubscribeBridge: (() => void) | null = null
  private stateListeners = new Set<Listener>()
  private poseListeners = new Set<PoseListener>()

  get snapshot(): VrLinkSnapshot {
    return this.cached
  }

  get jointAngles(): number[] | null {
    return this.q
  }

  subscribe = (cb: Listener) => {
    this.stateListeners.add(cb)
    return () => {
      this.stateListeners.delete(cb)
    }
  }

  /** 3D 视口用的高频通道：不走 React 渲染循环 */
  subscribePose = (cb: PoseListener) => {
    this.poseListeners.add(cb)
    return () => {
      this.poseListeners.delete(cb)
    }
  }

  start = () => {
    if (this.tickTimer !== null) return
    const now = performance.now()
    this.lastTickAt = now
    this.lastNotifyAt = 0
    this.unsubscribeBridge = vrBridge.subscribe(this.handleBridgeChange)
    // 桥连接是 app 级的：控制页/遥操页也要能知道 VR 在不在控，所以这里只订阅、
    // 不负责开关连接（见 vrBridgeClient 的 start()：地址没配就不去连）。
    vrBridge.start()
    this.update(now)
    this.tickTimer = window.setInterval(this.tick, TICK_MS)
  }

  stop = () => {
    if (this.tickTimer === null) return
    window.clearInterval(this.tickTimer)
    this.tickTimer = null
    this.unsubscribeBridge?.()
    this.unsubscribeBridge = null
    // 不在这里 vrBridge.stop()：连接是 app 级常驻，离开 VR 页只是停止本页的消费
  }

  startFollow = () => {
    vrBridge.sendAction('teleop.start')
  }

  stopFollow = () => {
    vrBridge.sendAction('teleop.stop')
  }

  /** 急停：下发给桥（桥不在时按钮本就是禁用的，这里只是个兜底） */
  emergencyStop = () => {
    vrBridge.sendAction('estop')
  }

  private handleBridgeChange = () => {
    this.update(performance.now())
  }

  private tick = () => {
    this.lastTickAt = performance.now()
    this.update(this.lastTickAt)
  }

  private update(now: number) {
    const snapshot = vrBridge.snapshot

    if (vrBridge.online && snapshot) {
      const { fields, q } = mapBridgeSnapshot(snapshot)
      this.fields = fields
      if (q) this.setQ(q)
    } else {
      // 桥不在：整份空态。**不**动 q —— 上一组真值留着比编一组新的诚实，
      // 页面靠 bridgeOnline 把它标成"不是当前值"。
      this.fields = emptyBridgeFields()
    }

    if (now - this.lastNotifyAt >= UI_NOTIFY_MS) {
      this.lastNotifyAt = now
      this.emit()
    }
  }

  private setQ(next: number[]) {
    if (this.q && !qChanged(this.q, next)) return
    this.q = [...next]
    for (const cb of this.poseListeners) cb(this.q)
  }

  private emit() {
    // 每次变更都换一个新对象：useSyncExternalStore 靠引用比较决定是否重渲染
    this.cached = { ...this.fields, q: this.q ? [...this.q] : null }
    for (const cb of this.stateListeners) cb()
  }
}

export const vrLink = new VrLink()
