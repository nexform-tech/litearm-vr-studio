import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { armClient, useArmConnection, type JointParams } from '@/lib/arm'
import { vrBridge } from './vrDaemonClient'

/**
 * 电机负载读数（按臂）。
 *
 * ⚠ 来源是**真机状态**（`vrBridge.armStateFor`，上游汇总服务发的 `ArmStatus`）：逐轴力矩
 * `joints.tau`、MOS/线圈温度 `t_mos` / `t_coil`，夹爪在 `vr_grip` 里。以前这一路走的是
 * **上位机链路**（studio → daemon → 串口）—— 而 VR 遥操时那条链路是死的（串口在跟随
 * 服务手里），所以那张卡在现场一直是空转。改读真机状态之后，它报的才是真正在出力的一方。
 *
 * 额定力矩是另一回事：它是设备侧静态参数（`get_joint_params().tau_max`），不随帧变，
 * 所以仍从 daemon 读一次 —— 读不到就写"未读到额定值"，不用一个猜的数顶上。
 *
 * ⚠ 读不到的量一律是 `null`，界面写"—"。`0 N·m` 的意思是"这个轴确实没出力"，与"没读到"
 * 是两件事：填 0 会让操作员以为机械臂没在使劲。
 *
 * 采样 200ms 一拍：读数够用，又不跟着 100ms 的帧通知重渲染整页（与 `useArmMetrics`
 * 同一取舍）。峰值按**本次连接**统计：断开即清零，不把上一次会话的最大值留成"本次峰值"。
 */

const SAMPLE_MS = 200

/** 一行读数（一个轴，或夹爪那行）；没有读到的量一律 null。 */
export type LoadRow = {
  /** 当前力矩（N·m），保留符号；null = 没读到 */
  tau: number | null
  /** 本次连接内的峰值 |tau|（N·m）；null = 没读到 */
  peak: number | null
  /** MOS 温度（℃）；夹爪没有这一项 */
  tMos?: number | null
  /** 线圈温度（℃）；夹爪没有这一项 */
  tCoil?: number | null
}

/**
 * 一段表有没有数可画。
 *
 * `live` 是"跟随服务说它连着、并且这一帧真带了读数"；`offline` 是它自己报的断开；
 * `missing` 是这条臂的真机状态一个字节都还没收到过（或这一版跟随服务根本不发 `joints`）。
 * 三种都要在界面上有各自的说法，不能都写成 0。
 */
export type ArmLoadStatus = 'live' | 'offline' | 'missing'

export type ArmLoadView = {
  /** 臂身份（`vr_state` / `vr_arm` 帧里的 `arm`） */
  arm: string
  /** 真机状态报的设备名（`vr_arm` 的 `device`） */
  device: string
  status: ArmLoadStatus
  /** 逐轴读数，长度就是这条臂报了几轴 */
  joints: LoadRow[]
  /** 夹爪那行；null = 没收到过夹爪读数 */
  gripper: LoadRow | null
}

/**
 * 读数来源。`vrBridge` 就长这样，测试里换成假的即可 —— 采样逻辑不依赖那个单例。
 */
export type ArmReadoutSource = {
  arms: string[]
  armStateFor(arm: string): Frame | null
  gripStateFor(arm: string): Frame | null
}

type Frame = Record<string, unknown>

/**
 * 本次连接的峰值，键是"哪条臂的哪一路"（`{臂}#{轴序}` / `{臂}#grip`）。
 * 一个数一个键，断开时按臂前缀整片清掉，不留上一次会话的量。
 */
export type PeakBook = Map<string, number>

/** 读一个数：载荷里不是数就是没读到 —— 不做 `Number()` 硬转，那会把 null 变成 0。 */
function reading(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 取一个并行数组字段（上游 `JointArray` 就是一组同长的数组）。 */
function series(holder: Frame | null | undefined, key: string): unknown[] {
  const value = holder?.[key]
  return Array.isArray(value) ? value : []
}

function asObject(value: unknown): Frame | null {
  return typeof value === 'object' && value !== null ? (value as Frame) : null
}

/** 峰值只涨不落；这一路没有读数时返回 null（界面写"—"）。 */
function trackPeak(peaks: PeakBook, key: string, value: number | null): number | null {
  if (value === null) return null
  const peak = Math.max(peaks.get(key) ?? 0, Math.abs(value))
  peaks.set(key, peak)
  return peak
}

/** 这条臂断开/消失了：它的峰值跟着丢掉（"本次连接"就此结束）。 */
function clearPeaks(peaks: PeakBook, arm: string) {
  const prefix = `${arm}#`
  for (const key of [...peaks.keys()]) {
    if (key.startsWith(prefix)) peaks.delete(key)
  }
}

/** 一条臂的一行读数：当前、峰值、温度（温度只有轴有）。 */
function rowOf(peaks: PeakBook, key: string, tau: number | null, tMos?: number | null, tCoil?: number | null): LoadRow {
  return { tau, peak: trackPeak(peaks, key, tau), tMos, tCoil }
}

/** 一条臂这一拍的全部读数。 */
function armLoadOf(arm: string, state: Frame | null, grip: Frame | null, peaks: PeakBook): ArmLoadView {
  const device = typeof state?.device === 'string' ? state.device : ''
  // 只有跟随服务自己说"连着"才认这些数：它报断开时那几个数组可能还是上一帧的量，
  // 拿着当当前值比空着更危险
  const live = state?.connected === true
  const joints = asObject(state?.joints)
  const tau = live ? series(joints, 'tau') : []
  const tMos = live ? series(joints, 't_mos') : []
  const tCoil = live ? series(joints, 't_coil') : []

  const rows: LoadRow[] =
    tau.length === 0
      ? []
      : tau.map((value, i) =>
          rowOf(peaks, `${arm}#${i}`, reading(value), reading(tMos[i]), reading(tCoil[i])),
        )
  // 断开（或这一版跟随服务不发 joints）时这一臂的峰值不留
  if (rows.length === 0) clearPeaks(peaks, arm)

  // 夹爪断开时这一行只写"—"，并把它的峰值清掉（`trackPeak` 只在有读数时写键）
  const gripLive = grip?.connected === true
  const gripTau = gripLive ? reading(grip?.tau) : null
  const gripRow = grip ? rowOf(peaks, `${arm}#grip`, gripTau) : null
  if (!gripLive) peaks.delete(`${arm}#grip`)

  return {
    arm,
    device,
    status: !state ? 'missing' : !live ? 'offline' : rows.length > 0 ? 'live' : 'missing',
    joints: rows,
    gripper: gripRow,
  }
}

/**
 * 按臂读一遍 —— 一次采样就是一次调用。
 *
 * 臂清单来自 `vrBridge.arms`（桥认到快照的那几条，已排序）：认不到臂就没有可监控的量，
 * 卡如实说"没收到臂"，而不是摆几段长时间不会变的空位。只动峰值本，其余是纯读。
 */
export function readArmLoads(bridge: ArmReadoutSource, peaks: PeakBook): ArmLoadView[] {
  const arms = bridge.arms
  // 桥不再认得的臂：它的峰值也一起丢掉
  for (const key of [...peaks.keys()]) {
    if (!arms.some((arm) => key.startsWith(`${arm}#`))) peaks.delete(key)
  }
  return arms.map((arm) => armLoadOf(arm, bridge.armStateFor(arm), bridge.gripStateFor(arm), peaks))
}

export type ArmLoads = {
  arms: ArmLoadView[]
  /** 逐轴额定力矩 `tau_max`（N·m）；没读到就是 null，界面不编百分比 */
  rated: (number | null)[] | null
}

export function useArmLoads(): ArmLoads {
  // `arms` 每次调用都是新数组，直接当快照交给 useSyncExternalStore 会一直重渲染：
  // 用 join 出来的字符串（臂身份里不会出现 \0）做比较键。
  const armKey = useSyncExternalStore(vrBridge.subscribe, () => vrBridge.arms.join('\u0000'))
  const { status } = useArmConnection()
  const [arms, setArms] = useState<ArmLoadView[]>([])
  const [rated, setRated] = useState<(number | null)[] | null>(null)
  const peaks = useRef<PeakBook>(new Map())

  // 额定力矩是设备侧参数，不随帧变：上位机链路连着的时候读一次即可。
  // VR 遥操时那条链路是断的（串口在跟随服务手里），所以这里多半读不到 —— 如实标出来。
  useEffect(() => {
    if (status !== 'connected') {
      setRated(null)
      return
    }
    let dropped = false
    void armClient
      .getJointParams()
      .then((params: JointParams[]) => {
        // 读到的 0 不算额定值：真电机不会报 0 N·m，那是"这个字段没读到"的另一种写法
        if (!dropped) {
          setRated(params.map((p) => (Number.isFinite(p.tau_max) && p.tau_max > 0 ? p.tau_max : null)))
        }
      })
      .catch(() => {
        // 读不到额定值不影响读数本身，界面会标"未读到额定值"
        if (!dropped) setRated(null)
      })
    return () => {
      dropped = true
    }
  }, [status])

  useEffect(() => {
    const sample = () => setArms(readArmLoads(vrBridge, peaks.current))
    sample()
    const timer = setInterval(sample, SAMPLE_MS)
    return () => clearInterval(timer)
  }, [armKey])

  return { arms, rated }
}
