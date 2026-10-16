import { armClient } from '../../lib/arm/client'
import type { DaemonSocket } from '../../lib/arm/socket'
import type { VrBridgeSnapshot } from './vrTypes'

/**
 * VR 通道客户端 —— 走 daemon，不再自己连桥。
 *
 * 页面说不了 zenoh（浏览器里要说得先有 remote-api 插件），而桥现在说的是 zenoh；
 * 替它说的是 daemon（见 `daemon/src/litearm_studio_daemon/vr/session.py`）。这边只订
 * 它转出来的四种帧：
 *
 *   `vr_conn`   通道连接态：桥在不在、端点、认到几条臂
 *   `vr_state`  桥的状态快照（**每条臂一份**，`arm` 是臂身份）
 *   `vr_arm`    真机状态：角度 / 力矩 / 温度（上游汇总发的，原样）
 *   `vr_grip`   夹爪
 *
 * 动作走 `vr.*` 命令 —— daemon 把它变成对桥的 query，回执里带着"跟随服务到底接没接"
 * （`receipt.ok` 的判据在下游，不是"桥收到了"）。回执是异步的，所以这里**存下来**
 * 给页面读，而不是像以前那样只能知道"送出去了没有"。
 *
 * 为什么不再有"桥地址"：地址是 daemon 的事（同机默认 `tcp/127.0.0.1:7447`），页面
 * 跟 daemon 同源，没有可填的东西。
 */

/** 高频率的帧（真机状态上游按 100Hz 发）不该每帧都惊动 React。 */
const NOTIFY_INTERVAL_MS = 100

/** 桥的动作名 → daemon 的命令名（`vr.` 前缀走它自己的命令表）。 */
const ACTIONS: Record<string, string> = {
  'teleop.start': 'vr.teleop_start',
  'teleop.stop': 'vr.teleop_stop',
  estop: 'vr.estop',
}

/** daemon `vr_conn` 帧的连接信息。 */
export type VrConnInfo = {
  status: string
  endpoint: string
  /** 桥那边认到的臂（`vr_status` 报过来的）。 */
  arms: string[]
  error: string | null
}

type Json = Record<string, unknown>

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null ? (value as Json) : null
}

export class VrDaemonClient {
  private socket: DaemonSocket
  private connValue: VrConnInfo | null = null
  private snapshots = new Map<string, VrBridgeSnapshot>()
  private armStates = new Map<string, Json>()
  private gripStates = new Map<string, Json>()
  private receiptValue: Json | null = null
  private actionError: string | null = null
  private listeners = new Set<() => void>()
  private lastNotifyAt = 0
  private pendingNotify: ReturnType<typeof setTimeout> | null = null

  constructor(socket: DaemonSocket) {
    this.socket = socket
    socket.onFrame('vr_conn', (msg) => {
      this.connValue = {
        status: typeof msg.status === 'string' ? msg.status : 'waiting',
        endpoint: typeof msg.endpoint === 'string' ? msg.endpoint : '',
        arms: Array.isArray(msg.arms) ? (msg.arms as string[]) : [],
        error: typeof msg.error === 'string' ? msg.error : null,
      }
      // 连接态是"整页都在看"的东西：不节流
      this.notify()
    })
    socket.onFrame('vr_state', (msg) => this._applyDevice(msg, this.snapshots))
    socket.onFrame('vr_arm', (msg) => this._applyDevice(msg, this.armStates))
    socket.onFrame('vr_grip', (msg) => this._applyDevice(msg, this.gripStates))
    // 传输层一动，这些帧全都失效：不保留最后一帧"桥在线"，否则页面会在 daemon
    // 已经断掉之后继续显示读数（重连握手时 daemon 会重发 `vr_conn` 与已收到的快照）。
    socket.onLifecycle(() => {
      this.connValue = null
      this.snapshots.clear()
      this.armStates.clear()
      this.gripStates.clear()
      this.notify()
    })
  }

  /** 桥那条链路通不通（daemon 说的：它收到过快照才算在线）。 */
  get online(): boolean {
    return this.connValue?.status === 'connected'
  }

  get endpoint(): string {
    return this.connValue?.endpoint ?? ''
  }

  get conn(): VrConnInfo | null {
    return this.connValue
  }

  /** 认到快照的臂（排序后稳定，页面按它渲染几条）。 */
  get arms(): string[] {
    return [...this.snapshots.keys()].sort()
  }

  /** 第一条臂的快照 —— 单臂部署就是"那份"，`vrLink` 的既有映射照旧吃它。 */
  get snapshot(): VrBridgeSnapshot | null {
    const first = this.arms[0]
    return first ? (this.snapshots.get(first) ?? null) : null
  }

  snapshotFor(arm: string): VrBridgeSnapshot | null {
    return this.snapshots.get(arm) ?? null
  }

  /** 这条臂的真机状态（上游汇总发的 `ArmStatus`，字段原样）。 */
  armStateFor(arm: string): Json | null {
    return this.armStates.get(arm) ?? null
  }

  gripStateFor(arm: string): Json | null {
    return this.gripStates.get(arm) ?? null
  }

  /** 最近一次动作回执（桥那边说"跟随服务接没接"），给页面显示用。 */
  get lastReceipt(): Json | null {
    return this.receiptValue
  }

  /** 最近一次动作失败的原因（桥没回执 / 桥拒绝），成功时清空。 */
  get lastActionError(): string | null {
    return this.actionError
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** 连接由 app 级的 daemon socket 管，这里只是接口的对称（离开页面不停连接）。 */
  start = () => {}
  stop = () => {}

  /**
   * 发一个动作（`teleop.start` / `teleop.stop` / `estop`）。
   *
   * 返回"通道通不通"——回执是异步的（`lastReceipt` / `lastActionError`），桥不在时
   * 调用方照旧该把按钮禁用。
   *
   * `payload` 原样进请求体（daemon 那边不解释、桥那边按动作自己读）—— 这三个动作今天
   * 不带参数，留着是为了下一个带参的动作不必再改一遍这条通路（以前这里把它丢掉了，
   * 那种"参数明明传了却没生效"的错最难查）。
   */
  sendAction = (action: string, payload?: Record<string, unknown>): boolean => {
    const method = ACTIONS[action]
    if (!method) return false
    if (!this.online) return false
    this.socket
      .sendCmd(method, payload)
      .then((value) => {
        const reply = asObject(value)
        this.receiptValue = asObject(reply?.receipt) ?? reply
        this.actionError = null
        this.notify()
      })
      .catch((err: unknown) => {
        // 桥没回执 / 桥拒绝：如实记下来给页面读（急停没停成不能显示成成功）
        this.actionError = err instanceof Error ? err.message : String(err)
        this.notify()
      })
    return true
  }

  /**
   * 列出**桥那台机器**上可能是机械臂的硬件口。
   *
   * 为什么不自己列：默认同机、允许跨机（桥的设计文档决策 4）。桥在另一台机器上时，
   * 本机枚举出来的口与真正插着臂的那台毫无关系 —— 列得越多，越容易挑一个"本机看着对、
   * 现场其实不存在"的名字。
   */
  listPorts = async (): Promise<Json | null> =>
    asObject(await this.socket.sendCmd('vr.list_ports'))

  /**
   * 确认「哪条串口接在哪条臂、夹爪在哪个 CAN 口」—— 桥负责落盘并当场生效。
   *
   * 两张表都是**部分更新**：只放这次改动过的那几条臂。
   *
   * 与 `sendAction` 的差别：这里**把 promise 交回调用方**。那张卡要显示桥拒绝的原话
   * （同一个口给了两条臂、跟随服务还在跑、命令是自定义的…），而"最近一次回执"是给
   * 三个开关按钮共用的槽位，卡片读它会串台。
   */
  setArmDevices = async (
    devices: Record<string, string>,
    grippers: Record<string, string> = {},
  ): Promise<Json | null> =>
    asObject(await this.socket.sendCmd('vr.set_arm_devices', { devices, grippers }))

  private _applyDevice<T>(msg: Json, into: Map<string, T>) {
    const arm = typeof msg.arm === 'string' ? msg.arm : ''
    const state = asObject(msg.state)
    if (!arm || state === null) return
    into.set(arm, state as T)
    this.notifySoon()
  }

  private notify() {
    if (this.pendingNotify) {
      clearTimeout(this.pendingNotify)
      this.pendingNotify = null
    }
    this.lastNotifyAt = performance.now()
    for (const cb of this.listeners) cb()
  }

  /** 高频帧用：最多每 `NOTIFY_INTERVAL_MS` 惊动一次 React（值本身是每一帧都存）。 */
  private notifySoon() {
    const elapsed = performance.now() - this.lastNotifyAt
    if (elapsed >= NOTIFY_INTERVAL_MS) {
      this.notify()
      return
    }
    if (this.pendingNotify) return
    this.pendingNotify = setTimeout(() => {
      this.pendingNotify = null
      this.notify()
    }, NOTIFY_INTERVAL_MS - elapsed)
  }
}

export const vrBridge = new VrDaemonClient(armClient.socket)
