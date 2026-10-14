/**
 * 「谁在控臂」的跨链路合成 —— VR 页留在 studio 的真正理由。
 *
 * 机械臂有两条互斥的控制链路（DESIGN 1.1）：
 *
 *   VR 链路：头显 → litearm-vr-bridge → metavr 逆解 → arm_follow_server → 真机
 *   上位机链路：studio → litearm-server :7449 → 真机
 *
 * litearm-vr-bridge 只看得到第一条链路，它报的 `owner` 只可能是 `vr` / `none`
 * （见 bridge 的 snapshot()）；第二条链路在 studio 手里 —— 只有 studio 知道自己
 * 有没有连着 litearm-server、有没有正在下发动作。所以"最终归属"必须在 studio
 * 合成（DESIGN 6.5："本服务只负责 VR 侧在不在控，最终展示由 studio 合成"）。
 *
 * 两条链路不能同时占用同一批电机，所以合成结果有两个用途：
 *   1. 界面上一眼看出当前是谁在控（而不是把桥报的 `none` 当成"没人控"）；
 *   2. 一旦两侧都在控，立刻给出红色互斥告警，并拦住 VR 侧的"开始遥操"。
 *
 * 判定只看"是否真的在驱动"，不看"是否连着"：上位机一打开就会连 litearm-server，
 * 空闲待机是常态，不能因此判成"上位机在控"（否则 VR 永远起不来）。
 */

/** 合成后的控制归属；`conflict` = 两条链路同时认为自己在控（危险态） */
export type VrOwner = 'vr' | 'console' | 'none' | 'conflict'

/** 上位机侧"在动"的具体形式 */
export type VrConsoleActivity = 'motion' | 'following' | 'zero_gravity' | 'impedance' | 'stopping'

/** studio 侧（litearm-server :7449）的原始观测 */
export type VrConsoleSignals = {
  /** litearm-server 连接是否在 */
  connected: boolean
  /** 当前连接地址（显示用） */
  endpoint: string
  /** 有运动 RPC 在途（movej / movel / 回放 / 回零…） */
  motionBusy: boolean
  /** litearm-server 广播的机械臂状态机（`RobotState.state`） */
  robotState: string | null
}

export type VrConsoleView = VrConsoleSignals & {
  /** 正在以什么方式驱动机械臂；null = 连着但空闲 */
  activity: VrConsoleActivity | null
  inControl: boolean
}

export type VrOwnership = {
  owner: VrOwner
  /** 两条链路同时在控 */
  conflict: boolean
  vrActive: boolean
  console: VrConsoleView
}

/**
 * litearm-server 广播里表示"机械臂正被上位机驱动"的状态。
 *
 * `ready` / `holding` 是静止态（上位机连上但没在动，或者动完停在那里），不算在控；
 * 这与桥判 `owner=vr` 的口径一致（桥也只在 following / MOVE_* 时算 VR 在控）。
 * 状态取值见 `features/solo/soloUtils.ts` 的 ARM_OPERATIONAL_STATES 与
 * `features/solo/useSoloState.ts` 的阻抗分支。
 */
const CONSOLE_ACTIVITY_BY_STATE: Record<string, VrConsoleActivity> = {
  moving: 'motion',
  following: 'following',
  zero_gravity: 'zero_gravity',
  impedance: 'impedance',
  joint_impedance: 'impedance',
  cartesian_impedance: 'impedance',
  stopping: 'stopping',
}

/**
 * 桥报"VR 侧在控"时，真机跟随服务可能处于的状态。
 * 与 litearm-vr-bridge `bridge.py` 的 MANAGED_ARM_STATES 保持一致：
 * `following` 是 SDK 版状态名，`MOVE_*` 是 stm32 版逐帧跟随的模式名。
 */
const VR_MANAGED_ARM_STATES = new Set(['following', 'MOVE_JS', 'MOVE_MIT', 'MIT_ALL'])

/**
 * 桥报的 VR 侧是否在控（与 litearm-vr-bridge 的判定同口径）。
 * 单独导出给 app 级闸门用：控制页拦动作时只需要这一半，
 * 不用把上位机侧的状态也拉进来。
 */
export function bridgeVrActive(input: {
  bridgeOwner: string
  bridgeFollowing: boolean
  bridgeArmState: string | null
}): boolean {
  return (
    input.bridgeOwner === 'vr' ||
    input.bridgeFollowing ||
    (input.bridgeArmState != null && VR_MANAGED_ARM_STATES.has(input.bridgeArmState))
  )
}

/** studio 侧正在以什么方式驱动机械臂；null = 没在驱动（含未连接） */
export function consoleActivityOf(signals: VrConsoleSignals): VrConsoleActivity | null {
  if (!signals.connected) return null
  if (signals.motionBusy) return 'motion'
  const state = signals.robotState ?? ''
  return CONSOLE_ACTIVITY_BY_STATE[state] ?? null
}

/**
 * 把桥（VR 侧，只有 vr/none）与 studio 自己（上位机侧）合成为最终归属。
 *
 * 之所以不能只看桥：桥报 `none` 时机械臂完全可能正被上位机的 movej 或拖动
 * 驱动着，界面若照抄 `none` 就会告诉操作员"没人控臂"。
 */
export function synthesizeOwnership(input: {
  /** 桥快照里的 owner（只有 vr / none，未知值一律按没在控处理） */
  bridgeOwner: string
  /** 桥报的头显是否在跟随（grip 语义） */
  bridgeFollowing: boolean
  /** 桥报的真机状态（跟随服务上报） */
  bridgeArmState: string | null
  /** studio 自己的观测 */
  console: VrConsoleSignals
}): VrOwnership {
  const vrActive = bridgeVrActive(input)

  const activity = consoleActivityOf(input.console)
  const consoleView: VrConsoleView = { ...input.console, activity, inControl: activity !== null }
  const conflict = vrActive && consoleView.inControl

  return {
    owner: conflict ? 'conflict' : vrActive ? 'vr' : consoleView.inControl ? 'console' : 'none',
    conflict,
    vrActive,
    console: consoleView,
  }
}
