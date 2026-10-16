/**
 * 真机状态（`vr_arm`）的样例固件。
 *
 * 对端是**上游那台状态汇总服务**发的 `ArmStatus`（`litearm-vr-follow/status_msgs.py`），
 * 由桥当受管进程起起来、按臂发到 `litearm/v4/{臂}/vr_arm`。
 *
 * `ARM_FOLLOWING` 是**真抓的**（2026-10-16）：桥与上游那台汇总服务都真跑起来，对端是一个
 * 按 `arm_follow_server_*.py` 协议应答的假跟随服务（这台上位机没有真机，接不了串口）。
 * 其余几份按同一形状造数 —— 断开与故障那两种没法"造一个真机出来"抓。
 *
 * ⚠ 改上游的 `ArmStatus` 时这里要跟着改：这份载荷是 `Frame`（页面按未知形状读，上游加
 *   字段不该让页面崩），TS 拦不住。
 *
 * 两版跟随服务报的不是一套东西（见 litearm-vr-bridge `docs/FOLLOW-SERVER-COMPAT.md`）：
 * sdk 版报 `fault`（`[关节, 错误]` 两元组），stm32 版报 `flags`（置位名）。样例两种都给。
 */

/** 页面按未知形状读（上游加字段不该让页面崩），所以样例也是普通对象。 */
export type ArmStatusFrame = Record<string, unknown>

/**
 * 一条臂的一帧真机状态；字段与默认值照**抓下来的那一份**抄（见 `ARM_FOLLOWING`）。
 *
 * 那两个 `null`（`mode` / `following`）是 sdk 版跟随服务的实情：它的回包里没有这两样，
 * 归一化后就是 null。别按"应该有"填上 —— 页面得能容忍它们缺席。
 */
export function armStatus(over: ArmStatusFrame = {}): ArmStatusFrame {
  return {
    name: 'armA',
    device: '/dev/serial/by-id/usb-STMicroelectronics_LiteArm_LL-2024-if00',
    connected: true,
    ok: true,
    source: 'sdk',        // 哪一版跟随服务（**不是**仿真/真机）
    state: 'holding',
    mode: null,
    enabled: null,
    following: null,
    flags: [],
    fault: [],
    joint_fault: null,
    q: [0.0, -0.07, -0.09, -1.7, -1.46, -0.03, -0.79],
    joints: null,
    age_ms: 12.0,
    error: null,
    ...over,
  }
}

/** 头显没接入 / 停止遥操之后：跟随服务连着、就地持位 */
export const ARM_HOLDING = armStatus()

/** 正在跟随：**真抓的**那一份（2026-10-16，桥 + 汇总服务 + 假跟随服务） */
export const ARM_FOLLOWING = armStatus({
  state: 'following',
  q: [0.21, 0.14, 0.12, -1.49, -1.25, 0.18, -0.58],
  age_ms: 0.6,
})

/** 跟随服务自己报断开：那几个数可能还是上一帧的，页面该照"断开"说话 */
export const ARM_DISCONNECTED = armStatus({
  connected: false,
  ok: false,
  state: null,
  q: null,
  error: 'serial closed',
})

/** 带故障：stm32 版是 `flags` 里的置位名，sdk 版是 `fault` 里的两元组 */
export const ARM_FAULTED = armStatus({
  state: 'fault',
  flags: ['FB_STALE'],
  fault: [[3, 8]],
  joint_fault: 3,
})
