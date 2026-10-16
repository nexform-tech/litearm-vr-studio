/** VR 页与数据源之间共用的类型。 */

export type VrArmSource = 'sim' | 'real'

/** 桥侧遥操状态机（DESIGN 6.4：IDLE → FOLLOWING → LATCHED / FALLBACK） */
export type VrLinkState = 'idle' | 'following' | 'latched' | 'fallback'

/** 桥托管的进程详情；页面不再展示，保留在载荷类型里是因为桥仍在推（DESIGN 2.1 / M3） */
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

/**
 * 桥推来的一次性事件：告警 + 动作回执（DESIGN 4.1 的 events）。
 * 页面不再展示，保留在载荷类型里是因为桥仍在推。
 */
export type VrBridgeEvent = {
  id: number
  ts: number
  level: VrBridgeEventLevel
  code: string
  message: string
  data?: Record<string, unknown>
}

/**
 * VR 页消费的链路状态。
 *
 * 字段覆盖桥的整条链路：头显侧 → 桥自身 → metavr → 跟随服务 → 真机，外加兜底与归属。
 *
 * ⚠ 这一页**没有**兜底数据源：桥连不上时下面这些字段就是空态（0 / false / null），
 * 页面照实显示"未连接"。遥操页上出现编造的「已连接 90Hz」和一条看起来在动的机械臂
 * 姿态，是会被当真的事故源。
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
  /** 无线段延迟（ms）：桥收到帧时刻 − 帧内 timestamp；不含转发与解算（DESIGN 6.2） */
  latencyMs: number
  /** 头显时钟与上位机不可比：上面的数是相对窗口内最小值的增量，不是绝对延迟 */
  latencyEstimated: boolean
  /** 距上一帧的时间（ms） */
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
  /** 兜底是否启用（桥侧 FALLBACK_ENABLED；关掉后无帧超时只记事件、不自动 latch） */
  fallbackGuardEnabled: boolean
  /** 帧流异常告警阈值（ms） */
  warnMs: number
  /** 兜底持位阈值（ms） */
  fallbackMs: number

  // ── 真机侧（**全部**来自上游汇总服务按臂发的 `vr_arm`，不是桥的快照）──
  /**
   * 这条臂的姿态是不是真机的：`real` = 跟随服务正连着（它报的就是真机），
   * `null` = 无从判断。
   *
   * ⚠ 没有 `sim` 这一档：仿真/真机是**桥那一侧**的事，而桥现在不照下游，这个信息
   *   在新链路上没有任何地方报。以前这里是 `sim`（老桥的 `ARM_SOURCE`），那是在
   *   替一条已经不存在的通道说话 —— 宁可说"不知道"。
   */
  armSource: VrArmSource | null
  /** 跟随服务是否在报（`vr_arm` 的 `connected`）：它说断开时那些数可能还是上一帧的 */
  armConnected: boolean
  /** 跟随服务上报的状态（`following` / `MOVE_JS` / `holding` / `fault` …） */
  armState: string | null
  /** 跟随服务最后一次失败的原因 */
  armError: string | null
  /**
   * 跟随服务报的故障码，**原样留着**；空数组 = 健康，null = 还没收到过真机状态。
   *
   * 两种形状都要能显示：sdk 版是 `fault` 里的 `[joint, err]` 两元组，stm32 版是
   * `flags` 里的置位名（见 litearm-vr-bridge `docs/FOLLOW-SERVER-COMPAT.md`）。
   * 两条都收在一个数组里，不压成个数 —— 压掉了就再也说不出"是哪个关节、什么错"。
   */
  armFault: unknown[] | null
  /**
   * 机械臂 7 关节角（rad），**只在桥真的报过姿态之后才有值**。
   * null = 一个真实字节都没收到过，界面显示"—"，而不是拿一个编造的姿态顶上。
   */
  q: number[] | null

  // ── 归属 ──
  /** 谁在控臂：vr / console / none（DESIGN 6.5） */
  owner: string
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
  /**
   * 这条臂的**身份与去处**：它是谁、接在哪、follow 在哪（bridge DESIGN §4.4）。
   *
   * ⚠ 这里**没有**真机状态（连接 / 状态 / 故障 / 关节角）。桥从 `4c7a772` 起不再照
   *   下游：那些字段改由上游那台汇总服务按臂发在 `vr_arm` 上，页面从 `vrArmStateOf`
   *   取。老桥的那几个字段（`source` / `q` / `state` / `fault` / `connected` …）已经
   *   从这条契约里拿掉 —— 留着它们，页面就会一直读到空值还以为读到了东西。
   */
  arm?: {
    /** 上游的槽：`left` / `right`（决定由哪只手柄驱动） */
    side?: string
    /** 这条臂的硬件口（`/dev/serial/by-id/…` 或 CAN 口名） */
    device?: string
    /**
     * 这条臂那个夹爪的 CAN 口（`can0`）；空/缺席 = 这条臂没有夹爪。
     *
     * 它只喂给汇总服务的 `--gripper <身份>=<口>@<端点>` 对拍（真正驱动夹爪的是端点），
     * 但它错了界面上那个夹爪的身份就是错的 —— 所以映射卡把它跟串口并排摆出来。
     */
    gripper?: string
    /** 这个口是谁定的：`config`（装机时写的）/ `record`（操作员在界面上确认过的） */
    device_source?: string
    /** 来源是 `record` 时的确认时间（ISO 8601）；没有就是 null */
    device_confirmed_at?: string | null
    /** 这条臂的跟随服务端点 `host:port` */
    follow?: string
    /** 控制通道自述：桥发出去的命令有没有被接住（不是下游的状态） */
    commands?: {
      requests?: number
      failures?: number
      last_ok_age_ms?: number | null
      error?: string | null
    }
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
