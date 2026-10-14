/** VR 页与数据源之间共用的类型。 */

export type VrArmSource = 'sim' | 'real'

/** 数据来源：真实的 litearm-vr-bridge，还是本地演示数据 */
export type VrDataSource = 'bridge' | 'demo'

/** 桥侧遥操状态机（DESIGN 6.4：IDLE → FOLLOWING → LATCHED / FALLBACK） */
export type VrLinkState = 'idle' | 'following' | 'latched' | 'fallback'

/** 受管进程状态；unknown = 桥那边没配这个进程的命令 */
export type VrProcessStatus = 'running' | 'stopped' | 'crashed' | 'unknown'

export type VrProcessDetail = {
  status?: string
  command?: string
  pid?: number | null
  uptime_s?: number | null
  exit_code?: number | null
  starts?: number
  last_error?: string | null
}

export type VrBridgeEventLevel = 'debug' | 'info' | 'warn' | 'danger'

/** 桥推来的一次性事件：告警 + 动作回执（DESIGN 4.1 的 events） */
export type VrBridgeEvent = {
  id: number
  ts: number
  level: VrBridgeEventLevel
  code: string
  message: string
  data?: Record<string, unknown>
}

/**
 * VR 页消费的链路状态（演示数据与真实桥共用同一形状）。
 *
 * 字段覆盖桥的整条链路：头显侧 → 桥自身 → metavr → 跟随服务 → 真机，
 * 外加兜底/进程/事件。演示数据也必须填满（页面各处不做空值分支）。
 */
export type VrLinkSnapshot = {
  // ── 头显侧 ──
  /** 头显是否在推手柄帧（阈值内的最近一帧） */
  headsetOnline: boolean
  /** 头显 WebSocket 是否连着（连着但不推帧，online 会是 false） */
  headsetConnected: boolean
  /** 是否正在跟随（由 grip 语义推断） */
  following: boolean
  /** 右手握把键当前是否按下 */
  grip: boolean
  /** 右手手柄是否被跟踪 */
  tracked: boolean
  /** 手柄位姿帧率（Hz） */
  fps: number
  /** 端到端延迟（ms）：收到帧时刻 − 帧内 timestamp */
  latencyMs: number
  /** 延迟是否为估计值（头显时钟与上位机不可比时的退化口径） */
  latencyEstimated: boolean
  /** 距最近一帧的时间（ms） */
  sinceFrameMs: number
  /** 累计收到的帧数 */
  frames: number
  /** 已转发给 metavr 的帧数 */
  framesForwarded: number
  /** 因 metavr 未连接/写超时而丢掉的帧数 */
  framesDropped: number
  /** 被桥拦下没转发的帧数（点了"停止遥操"之后头显仍推的那些） */
  framesBlocked: number

  // ── 桥自身 ──
  /** 桥的 WebSocket 是否可达 */
  bridgeOnline: boolean
  bridgeVersion: string
  bridgeUptimeS: number
  /** 桥"收帧→转发"自身耗时（ms），正常 < 1ms；变大即说明桥卡了 */
  forwardCostMs: number
  /** 最近窗口内的转发耗时峰值（ms） */
  forwardCostMaxMs: number
  /** 桥到 metavr 的连接是否在 */
  metavrConnected: boolean
  /** 订阅状态的客户端数（含本页） */
  statusClients: number

  // ── 遥操状态机 ──
  linkState: VrLinkState
  /** 操作员是否开着遥操（teleop.start / teleop.stop） */
  linkEnabled: boolean
  /** 帧转发是否打开（停止遥操后为 false：头显照推但一个字都不转发） */
  forwardEnabled: boolean
  /** 是否必须重新按 grip 才会恢复跟随（停止/急停/兜底之后） */
  rearmRequired: boolean
  fallbackActive: boolean
  fallbackReason: string | null
  /** 兜底护栏是否启用（关掉后只告警不自动 latch） */
  fallbackGuardEnabled: boolean
  /** 帧流异常告警阈值（ms） */
  warnMs: number
  /** 兜底持位阈值（ms） */
  fallbackMs: number

  // ── 真机侧 ──
  /** 机械臂姿态来源：仿真 / 真机 */
  armSource: VrArmSource
  /** 跟随服务（9001）是否可达 */
  armConnected: boolean
  /** 跟随服务上报的状态（following / holding / fault …） */
  armState: string | null
  /** 跟随服务最后一次失败的原因 */
  armError: string | null
  /** 距最后一次成功 ping 的时间（ms） */
  armLastOkMs: number | null
  /** 故障码个数 */
  faultCount: number
  /** 机械臂 7 关节角（rad） */
  q: number[]

  // ── 进程与归属 ──
  processes: Record<string, VrProcessStatus>
  processesDetail: Record<string, VrProcessDetail>
  /** 谁在控臂：vr / console / none（DESIGN 6.5） */
  owner: string

  /** 当前数据来自哪里 */
  dataSource: VrDataSource
  /** 桥推来的告警与动作回执（按 id 去重、按时间倒序） */
  events: VrBridgeEvent[]
}

/**
 * litearm-vr-bridge `/ws/status` 的载荷。
 * 契约见 litearm-vr-bridge/docs/DESIGN.md 第 4.1 节；字段一律按可选处理，
 * 桥端增删字段不应让页面崩掉。
 */
export type VrBridgeSnapshot = {
  ts?: number
  bridge?: {
    online?: boolean
    version?: string
    /**
     * 注意：桥在还没有样本时会发 `null`（例如刚起来还没收到帧，`forward_cost_ms` 就是 null）。
     * 页面侧统一用 `finite()` 兜底成 0，但类型要如实写。
     */
    uptime_s?: number | null
    forward_cost_ms?: number | null
    forward_cost_last_ms?: number | null
    forward_cost_max_ms?: number | null
    clients?: { headset?: number; status?: number }
    metavr_connected?: boolean
  }
  headset?: {
    online?: boolean
    connected?: boolean
    fps?: number
    latency_ms?: number | null
    latency_estimated?: boolean
    last_frame_age_ms?: number | null
    following?: boolean
    grip?: boolean
    tracked?: boolean
    frames?: number
    bad_frames?: number
    frames_forwarded?: number
    frames_dropped?: number
    frames_blocked?: number
    last_frame_ts?: number | null
  }
  arm?: {
    source?: string
    q?: number[] | null
    state?: string | null
    fault?: unknown[] | null
    connected?: boolean
    last_ok_age_ms?: number | null
    error?: string | null
  }
  processes?: Record<string, string>
  processes_detail?: Record<string, VrProcessDetail>
  link?: {
    state?: string
    enabled?: boolean
    forward_enabled?: boolean
    rearm_required?: boolean
    warn_ms?: number
    fallback_ms?: number
  }
  owner?: string
  fallback?: { active?: boolean; reason?: string | null; guard_enabled?: boolean }
  events?: VrBridgeEvent[]
}
