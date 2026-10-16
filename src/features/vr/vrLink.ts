import { vrBridge } from './vrDaemonClient'
import type { VrBridgeSnapshot, VrLinkSnapshot, VrLinkState } from './vrTypes'

/**
 * VR 页的数据编排层：**唯一**对外暴露的取数口。
 *
 * 数据都来自 daemon 转出来的帧（页面自己说不了 zenoh，见 `vrDaemonClient`），这一页
 * 用到两种：
 *
 *   `vr_state`  桥的状态快照，**每条臂一份** —— 跟随态、帧率、延迟、兜底、归属
 *   `vr_arm`    真机状态（上游汇总服务发的） —— 关节角 `q`、以及负载卡要的力矩/温度
 *
 * 所以这里出两个视图：整机那一份（`snapshot`，取第一条臂，控制卡与链路卡照旧吃它），
 * 以及**逐臂**那一份（`arms`）—— 双臂时要看得出是两条臂各自的状态，而不是一份。
 *
 * 真实链路（见 litearm-vr-bridge/docs/DESIGN.md）：
 *   头显 → 桥 :8765 → metavr（pybullet 逆解）→ TCP 9001 → arm_follow_server → 真机
 *
 * 桥连不上时页面显示空态，不拿任何本地编造的数据顶上 —— 这一页的每个数字都可能是
 * 操作员据以判断"机械臂现在在不在动"的依据，假数据比没有数据危险得多。唯一**留着**的
 * 是最后一次真值（关节角、臂清单、设备名）：把它们清成零位等于说机械臂在零位，那才是编数。
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
/** 帧载荷（`vr_arm` 等）按未知形状读：上游加字段不该让页面崩。 */
type Frame = Record<string, unknown>

/** 页面字段里除 q 之外的部分（q 走 3D 视口的高频通道，单独通知） */
export type VrBridgeFields = Omit<VrLinkSnapshot, 'q'>

/**
 * 一条臂的视图：桥那份快照映射出的字段 + 这条臂自己的真机姿态。
 *
 * 桥的 `vr_state` 本来就是**每条臂一份**，所以"跟随中 / 故障 / 归属"这些字段都该按臂看。
 * 关节角 `q` 取自上游汇总发的 `vr_arm`（`armStateFor(arm).q`）—— 桥快照里那段真机状态
 * 已经没有了。
 */
export type VrArmView = VrLinkSnapshot & {
  /** 臂身份（`vr_state` / `vr_arm` 帧里的 `arm`，也是 `vrBridge.arms` 里那一条） */
  arm: string
  /** 真机状态报的设备名（`vr_arm` 的 `device`）；没收到过就是空串 */
  device: string
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * 真机状态（上游汇总服务按臂发的 `ArmStatus`）→ 页面那几个"臂"字段。
 *
 * ⚠ **臂的字段只有一个来源，就是这里**。桥的快照里那段 `arm` 只剩身份与去处
 *   （谁、接在哪、follow 在哪），真机状态桥不转了（`4c7a772` 起）—— 以前页面从桥的
 *   快照里读 `connected` / `state` / `fault`，那几个字段早就不发了，于是"跟随服务"
 *   那一跳永远显示"未连接"、故障永远显示不出来，而机械臂其实正在跟着动。
 *
 * `armSource` 只说得出"真机"与"不知道"：仿真/真机是桥那一侧的事，新链路上没有地方报
 * 它（见 `VrLinkSnapshot.armSource`）。**不拿 `sim` 顶上** —— 那会把"不知道"说成
 * "在跑仿真"。
 */
export function armFieldsOf(state: Frame | null): Pick<
  VrBridgeFields, 'armSource' | 'armConnected' | 'armState' | 'armError' | 'armFault'
> {
  const connected = state?.connected === true
  // 两种版本的跟随服务报的不是一个字段：sdk 报 `fault`（`[关节, 错误]`），stm32 报
  // `flags`（置位名），语义一致、健康时都空。合成一条列表，`formatArmFault` 都认。
  const fault = Array.isArray(state?.fault) ? state.fault : []
  const flags = Array.isArray(state?.flags) ? state.flags : []
  return {
    armSource: connected ? 'real' : null,
    armConnected: connected,
    armState: typeof state?.state === 'string' ? state.state : null,
    armError: typeof state?.error === 'string' ? state.error : null,
    // null = 一个字节都没收到过（页面写"—"），[] = 收到了、是健康的
    armFault: state === null ? null : [...flags, ...fault],
  }
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
    armSource: null,
    armConnected: false,
    armState: null,
    armError: null,
    armFault: null,
    owner: 'none',
  }
}

/**
 * 把桥的一份快照映射成页面字段；缺字段一律退默认，不让页面崩。
 *
 * ⚠ 这里**只管桥这条链路**（头显 / 桥自身 / 状态机 / 兜底 / 归属）。臂那一组
 *   （连接、状态、故障、来源）不在这份快照里 —— 它由 `armFieldsOf` 从 `vr_arm` 填，
 *   在 `readArm` 里合上去。两处的分工要守住：桥的快照里那段 `arm` 只剩身份与去处。
 */
export function mapBridgeSnapshot(snapshot: VrBridgeSnapshot): VrBridgeFields {
  const headset = snapshot.headset ?? {}
  const bridge = snapshot.bridge ?? {}
  const link = snapshot.link ?? {}
  const fallback = snapshot.fallback ?? {}

  return {
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
    // 臂那一组在 `readArm` 里从 `vr_arm` 补上（见 `armFieldsOf`）。这里给的是空态：
    // 一个字节都没收到过时，页面就该显示"未连接 / —"，而不是拿编造的值顶上。
    ...armFieldsOf(null),
    owner: asString(snapshot.owner, 'none'),
  }
}

/**
 * 一条臂的关节角（rad），取自真机状态（`vr_arm` 的 `q`）。
 *
 * 只有"长度 7 且都是有限数"才采用：本页的 3D 模型就是 7 轴，拿长度不对的数组去驱动它，
 * 画面会比不更新更假。返回 null 时调用方**保留上一组值**，不拿零位顶上。
 */
export function armQ(state: Frame | null): number[] | null {
  const raw = state?.q
  return Array.isArray(raw) && raw.length === 7 && raw.every((v) => Number.isFinite(Number(v)))
    ? raw.map(Number)
    : null
}

function qChanged(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i] - b[i]) > Q_EPSILON) return true
  }
  return false
}

/** 一条臂在这层内部的状态；`emit` 时才包成对外的 `VrArmView`。 */
type ArmEntry = {
  device: string
  fields: VrBridgeFields
  /** 这条臂最后一次真机姿态；一个真实字节都没收到过时是 null */
  q: number[] | null
}

class VrLink {
  /** 当前认得的臂 → 它那一份状态。键序即排序，见 `emit`。 */
  private entries = new Map<string, ArmEntry>()
  private cached: VrLinkSnapshot = { ...emptyBridgeFields(), q: null }
  private cachedArms: VrArmView[] = []
  private tickTimer: number | null = null
  private lastNotifyAt = 0
  private unsubscribeBridge: (() => void) | null = null
  private stateListeners = new Set<Listener>()
  /** 姿态按臂分开发：双臂时两条臂各自的视口只跟自己那条的数据重画 */
  private poseListeners = new Map<string, Set<PoseListener>>()

  /** 整机那一份（第一条臂）：控制卡与链路卡吃它，与逐臂之前的行为一致 */
  get snapshot(): VrLinkSnapshot {
    return this.cached
  }

  /** 逐臂视图，按臂身份排序（与 `vrBridge.arms` 同序） */
  get arms(): VrArmView[] {
    return this.cachedArms
  }

  armFor(arm: string): VrArmView | null {
    return this.cachedArms.find((view) => view.arm === arm) ?? null
  }

  /** 这条臂最后一次真机姿态；null = 还没收到过（调用方显示空态，不编一个姿态） */
  poseFor(arm: string): number[] | null {
    const q = this.entries.get(arm)?.q
    return q ? [...q] : null
  }

  subscribe = (cb: Listener) => {
    this.stateListeners.add(cb)
    return () => {
      this.stateListeners.delete(cb)
    }
  }

  /** 3D 视口用的高频通道：按臂订阅，不走 React 渲染循环 */
  subscribePose = (arm: string, cb: PoseListener) => {
    const listeners = this.poseListeners.get(arm) ?? new Set<PoseListener>()
    listeners.add(cb)
    this.poseListeners.set(arm, listeners)
    return () => {
      listeners.delete(cb)
    }
  }

  start = () => {
    if (this.tickTimer !== null) return
    const now = performance.now()
    this.lastNotifyAt = 0
    this.unsubscribeBridge = vrBridge.subscribe(this.handleBridgeChange)
    // daemon 通道是 app 级的：控制页/遥操页也要能知道 VR 在不在控，所以这里只订阅、
    // 不负责开关连接（连接归 `armClient.socket`）。
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
    // 不在这里 vrBridge.stop()：连接是 app 级常驻，离开 VR 页只是停止本页的消费。
    // 已经在手的状态也不清：下一次进页面时它仍是"最后一次真值"（见 update）。
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
    this.update(performance.now())
  }

  private update(now: number) {
    const reported = vrBridge.arms

    if (vrBridge.online && reported.length > 0) {
      // 桥报了什么就是什么：不再报的臂从这里删掉（现场改了臂数，页面跟着变）
      for (const arm of [...this.entries.keys()]) {
        if (!reported.includes(arm)) this.entries.delete(arm)
      }
      for (const arm of reported) this.readArm(arm)
    } else {
      // 桥不在：**字段**归空态。臂清单、设备名与姿态留着 —— 上一次的真值比清成零位诚实，
      // 页面靠 `bridgeOnline` / `armConnected` 把它们标成"不是当前值"（与 q 的既有口径一致）。
      for (const entry of this.entries.values()) entry.fields = emptyBridgeFields()
    }

    if (now - this.lastNotifyAt >= UI_NOTIFY_MS) {
      this.lastNotifyAt = now
      this.emit()
    }
  }

  /**
   * 读一条臂：桥那份快照（整机 + 链路）与真机状态（`vr_arm`：连接 / 状态 / 故障 /
   * 关节角 / 设备名）各取各的，合成一条臂的视图。
   *
   * ⚠ 这两份**不能互相顶替**：桥的快照里那段 `arm` 只剩身份与去处，真机状态只有
   *   `vr_arm` 有。所以臂那一组字段一律以真机状态为准，缺帧就是空态（不是"沿用桥的"）。
   */
  private readArm(arm: string) {
    const previous = this.entries.get(arm)
    const state = vrBridge.armStateFor(arm)
    const snapshot = vrBridge.snapshotFor(arm)
    // 真机状态这一帧没报 q（或报了个不能用的）时保留上一组：3D 视口停在最后一次真值上，
    // 比跳回零位诚实
    const q = armQ(state) ?? previous?.q ?? null

    this.entries.set(arm, {
      device: asString(state?.device, previous?.device ?? ''),
      fields: { ...(snapshot ? mapBridgeSnapshot(snapshot) : emptyBridgeFields()), ...armFieldsOf(state) },
      q,
    })

    if (q && (!previous?.q || qChanged(previous.q, q))) {
      for (const cb of this.poseListeners.get(arm) ?? []) cb([...q])
    }
  }

  private emit() {
    // 每次变更都换一个新对象：useSyncExternalStore 靠引用比较决定是否重渲染
    const ordered = [...this.entries.keys()].sort()
    this.cachedArms = ordered.map((arm) => {
      const entry = this.entries.get(arm) as ArmEntry
      return { ...entry.fields, q: entry.q ? [...entry.q] : null, arm, device: entry.device }
    })
    const first = ordered.length > 0 ? (this.entries.get(ordered[0]) as ArmEntry) : null
    this.cached = first
      ? { ...first.fields, q: first.q ? [...first.q] : null }
      : { ...emptyBridgeFields(), q: null }
    for (const cb of this.stateListeners) cb()
  }
}

export const vrLink = new VrLink()
