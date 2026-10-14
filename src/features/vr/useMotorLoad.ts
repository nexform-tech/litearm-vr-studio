import { useEffect, useRef, useState } from 'react'
import { armClient, useArmConnection, useArmState, useJointCount, type JointParams } from '@/lib/arm'

/**
 * 电机负载读数。
 *
 * ⚠ 这一路的来源是**上位机链路**（studio → daemon → 串口），不是 VR 链路：
 * daemon 的 `state` 帧里有逐轴力矩 `tau`（N·m），`get_joint_params` 里有逐轴额定
 * `tau_max`。桥（litearm-vr-bridge）不报扭矩 —— 它的 `arm` 只有 q / state / fault，
 * 所以"VR 遥操时跟随服务是否占着串口"决定了这里有没有数，界面上要如实显示空态。
 *
 * 采样 200ms 一拍：读数够用，又不跟着 50Hz 广播重渲染整页（与 `useArmMetrics` 同一取舍）。
 * 峰值按**本次连接**统计：断开即清零，不把上一次会话的最大值留成"本次峰值"。
 */

const SAMPLE_MS = 200

export type MotorLoad = {
  /** 当前力矩（N·m），保留符号 */
  tau: number
  /** 本次连接内的峰值 |tau|（N·m） */
  peak: number
  /** 额定力矩 `tau_max`（N·m）；没读到参数时为 null，界面不编百分比 */
  rated: number | null
}

export function useMotorLoad(): { live: boolean; loads: MotorLoad[] } {
  const { status } = useArmConnection()
  const state = useArmState()
  // 轴数只认 daemon 报的 `n`（{1J} 台架上不能画 7 行，见 lib/arm/axes.ts）
  const jointCount = useJointCount()

  const [rated, setRated] = useState<number[] | null>(null)
  const [loads, setLoads] = useState<MotorLoad[]>([])
  const stateRef = useRef(state)
  stateRef.current = state
  const peaksRef = useRef<number[]>([])
  const live = status === 'connected' && state !== null

  // 额定力矩是设备侧参数，不随帧变：连着的时候读一次即可
  useEffect(() => {
    if (!live) {
      setRated(null)
      peaksRef.current = []
      return
    }
    let dropped = false
    void armClient
      .getJointParams()
      .then((params: JointParams[]) => {
        if (dropped) return
        setRated(params.map((p) => (Number.isFinite(p.tau_max) ? p.tau_max : 0)))
      })
      .catch(() => {
        // 读不到额定值不影响读数本身，界面会标"未读到额定值"
        if (!dropped) setRated(null)
      })
    return () => {
      dropped = true
    }
  }, [live])

  useEffect(() => {
    if (!live) {
      setLoads([])
      return
    }
    const timer = setInterval(() => {
      const tau = (stateRef.current?.tau ?? [])
        .slice(0, jointCount)
        .map((v) => (Number.isFinite(v) ? v : 0))
      const peaks = peaksRef.current
      setLoads(
        tau.map((value, i) => {
          const peak = Math.max(peaks[i] ?? 0, Math.abs(value))
          peaks[i] = peak
          return { tau: value, peak, rated: rated?.[i] ?? null }
        }),
      )
    }, SAMPLE_MS)
    return () => clearInterval(timer)
  }, [live, jointCount, rated])

  return { live, loads }
}
