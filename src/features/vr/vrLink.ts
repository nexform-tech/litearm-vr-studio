import { setBridgeEndpoint as persistBridgeEndpoint, vrBridge } from './vrBridgeClient'
import type {
  VrArmSource,
  VrBridgeEvent,
  VrBridgeSnapshot,
  VrLinkSnapshot,
  VrLinkState,
  VrProcessDetail,
  VrProcessStatus,
} from './vrTypes'

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
/** 事件列表上限：桥按 TTL 保留，页面只留最近这些 */
const MAX_EVENTS = 30

type Listener = () => void
type PoseListener = (q: number[]) => void

/** 页面字段里除 q / events 之外的部分（events 单独做去重合并） */
export type VrBridgeFields = Omit<VrLinkSnapshot, 'q' | 'events'>

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

const LINK_STATES: readonly VrLinkState[] = ['idle', 'following', 'latched', 'fallback']

function linkStateOf(value: unknown, fallback: VrLinkState): VrLinkState {
  return LINK_STATES.includes(value as VrLinkState) ? (value as VrLinkState) : fallback
}

function processStatusOf(value: unknown): VrProcessStatus {
  return value === 'running' || value === 'stopped' || value === 'crashed'
    ? value
    : 'unknown'
}

function normalizeProcesses(raw: Record<string, string> | undefined): Record<string, VrProcessStatus> {
  const out: Record<string, VrProcessStatus> = {}
  for (const [name, status] of Object.entries(raw ?? {})) out[name] = processStatusOf(status)
  return out
}

function normalizeProcessDetails(
  raw: Record<string, VrProcessDetail> | undefined,
): Record<string, VrProcessDetail> {
  const out: Record<string, VrProcessDetail> = {}
  for (const [name, detail] of Object.entries(raw ?? {})) {
    if (detail && typeof detail === 'object') out[name] = detail
  }
  return out
}

function normalizeEvents(raw: unknown): VrBridgeEvent[] {
  if (!Array.isArray(raw)) return []
  const out: VrBridgeEvent[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Partial<VrBridgeEvent>
    if (typeof e.code !== 'string' || !e.code) continue
    out.push({
      id: Number.isFinite(Number(e.id)) ? Number(e.id) : 0,
      ts: Number.isFinite(Number(e.ts)) ? Number(e.ts) : 0,
      level: e.level === 'debug' || e.level === 'warn' || e.level === 'danger' ? e.level : 'info',
      code: e.code,
      message: typeof e.message === 'string' ? e.message : '',
      data: e.data && typeof e.data === 'object' ? e.data : undefined,
    })
  }
  return out
}

/**
 * 合并桥推来的事件：按 id 去重、按时间倒序、封顶 `MAX_EVENTS`。
 *
 * 桥那边按 TTL 重复推同一批事件（见 bridge 的 EventLog），所以这里必须是幂等的；
 * 操作员手动关掉的事件进 `dismissed`，不会再被同一份快照带回来。
 */
export function mergeEvents(
  current: VrBridgeEvent[],
  incoming: VrBridgeEvent[],
  dismissed: ReadonlySet<number> = new Set(),
): VrBridgeEvent[] {
  const byId = new Map<number, VrBridgeEvent>()
  for (const event of current) if (!dismissed.has(event.id)) byId.set(event.id, event)
  for (const event of incoming) {
    if (dismissed.has(event.id)) continue
    // 同一 id 以桥的最新一份为准（消息里可能带"×N"合并计数）
    byId.set(event.id, event)
  }
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_EVENTS)
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
    faultCount: 0,
    processes: {},
    processesDetail: {},
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
      faultCount: Array.isArray(arm.fault) ? arm.fault.length : 0,
      processes: normalizeProcesses(snapshot.processes),
      processesDetail: normalizeProcessDetails(snapshot.processes_detail),
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
  private events: VrBridgeEvent[] = []
  private dismissedEvents = new Set<number>()
  /** 桥报过的最后一组关节角；一个真实字节都没收到过时是 null */
  private q: number[] | null = null
  private cached: VrLinkSnapshot = { ...this.fields, q: null, events: [] }
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

  get bridgeEndpoint(): string {
    return vrBridge.endpoint
  }

  /** 配过桥地址没有（没配过时页面提示去填，而不是显示"连不上"） */
  get bridgeConfigured(): boolean {
    return vrBridge.configured
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

  /** 进程启停（M3）：桥那边只认 name；未配置的进程会回一条失败事件 */
  startProcess = (name: string) => this.sendAction('process.start', { name })

  stopProcess = (name: string) => this.sendAction('process.stop', { name })

  /** 关掉一条事件（只影响本页显示；桥那边仍按 TTL 保留） */
  dismissEvent = (id: number) => {
    this.dismissedEvents.add(id)
    this.events = this.events.filter((event) => event.id !== id)
    this.refreshNow()
  }

  /** 清空事件：本地先清干净，顺带让桥也清（event.clear） */
  clearEvents = () => {
    for (const event of this.events) this.dismissedEvents.add(event.id)
    this.events = []
    vrBridge.sendAction('event.clear')
    this.refreshNow()
  }

  /** 切换桥地址（存 localStorage，立即重连） */
  setBridgeEndpoint = (endpoint: string) => {
    persistBridgeEndpoint(endpoint)
    this.refreshNow()
  }

  private sendAction(action: string, payload?: Record<string, unknown>): boolean {
    return vrBridge.sendAction(action, payload)
  }

  private handleBridgeChange = () => {
    this.update(performance.now())
  }

  private refreshNow() {
    this.update(performance.now())
    this.emit()
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
      this.events = mergeEvents(this.events, normalizeEvents(snapshot.events), this.dismissedEvents)
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
    this.cached = { ...this.fields, q: this.q ? [...this.q] : null, events: this.events }
    for (const cb of this.stateListeners) cb()
  }
}

export const vrLink = new VrLink()
