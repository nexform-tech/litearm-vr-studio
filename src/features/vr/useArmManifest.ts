import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { vrBridge } from './vrDaemonClient'
import type { VrBridgeSnapshot } from './vrTypes'

/**
 * 「哪条串口接在哪条臂」这张卡的数据与动作。
 *
 * 为什么要有这张卡：这条映射**填错不报错** —— 表现只是左手柄的解发给了右边那条臂，
 * 动作是错的、看起来却在动。而它决定的事一点都不小：由哪只手柄驱动、关节角往哪个
 * 端点发、哪条 follow 开哪个口。所以它必须是**看得见、改得动、并且记得住**的。
 *
 * 三个来源分开取，不合并成一个"设备名"：
 *
 *   * **桥认的口**（`vr_state` 快照的 `arm.device`）—— 桥按它起 follow 的命令行；
 *   * **这份口是谁定的**（`arm.device_source` / `device_confirmed_at`）—— 装机时写下的
 *     默认与操作员按实物确认过的，在界面上不该长得一样；
 *   * **真机回的口**（`vr_arm` 的 `device`，即 follow 真正打开的那个）—— 与上面不符就是
 *     "动错臂"的前兆，必须当场看得见。
 *
 * 候选项与写入都问**桥**：默认同机、允许跨机，本机枚举出来的口与真正插着臂的那台机器
 * 可能毫无关系（见 `litearm-vr-bridge` 的 `ports.py`）。改动由桥落盘（记录），所以换台
 * 上位机连过来看到的是同一份答案 —— 这正是"每次开始遥操在界面上现选一遍"做不到的。
 */

/** 采样节奏：与负载卡同一取舍（读数够用，又不跟着 100ms 的帧通知重渲染整页）。 */
const SAMPLE_MS = 200

type Frame = Record<string, unknown>

/** 一条臂的映射行。 */
export type ArmManifestRow = {
  /** 臂身份（`armA` / `armB`，也是话题中段） */
  arm: string
  /** 上游的槽：`left` / `right` —— 决定由哪只手柄驱动 */
  side: string
  /** 桥现在认的硬件口；空串 = 这版桥不报这个字段 */
  device: string
  /** 这个口是谁定的：`config` / `record`；空串 = 这版桥不报 */
  source: string
  /** 来源是 `record` 时的确认时间（ISO 8601）；没有就是空串 */
  confirmedAt: string
  /** 真机状态里 follow 回的口名；空串 = 还没收到过 */
  reported: string
}

/**
 * 读数来源。`vrBridge` 就长这样，测试里换成假的即可。
 */
export type ArmManifestSource = {
  arms: string[]
  snapshotFor(arm: string): VrBridgeSnapshot | null
  armStateFor(arm: string): Frame | null
}

/** 一次采样：桥认到的每条臂一行（纯读，不编臂也不补默认口）。 */
export function readArmManifest(source: ArmManifestSource): ArmManifestRow[] {
  return source.arms.map((arm) => {
    const block = source.snapshotFor(arm)?.arm
    const state = source.armStateFor(arm)
    return {
      arm,
      side: typeof block?.side === 'string' ? block.side : '',
      device: typeof block?.device === 'string' ? block.device : '',
      source: typeof block?.device_source === 'string' ? block.device_source : '',
      confirmedAt:
        typeof block?.device_confirmed_at === 'string' ? block.device_confirmed_at : '',
      reported: typeof state?.device === 'string' ? state.device : '',
    }
  })
}

/** 一条候选口（桥报的），`kind` 用来区分"稳定的名字"与"会漂的名字"。 */
export type PortCandidate = {
  path: string
  kind: string
}

export type ArmManifestView = {
  rows: ArmManifestRow[]
  /** 桥那台机器的候选口（列不出来时是上一次的结果，可能为空） */
  ports: PortCandidate[]
  portsError: string | null
  loadingPorts: boolean
  saving: boolean
  /** 桥拒绝的原话（同一个口给了两条臂、跟随服务还在跑…），不翻译 */
  error: string | null
  /** 刚刚保存成功的臂（空数组 = 没改动的保存） */
  saved: string[] | null
  /** 桥在线、且没在遥操：这时候才允许改 */
  canEdit: boolean
  refreshPorts: () => void
  save: (devices: Record<string, string>) => void
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function asReceipt(value: unknown): Frame | null {
  if (typeof value !== 'object' || value === null) return null
  const receipt = (value as Frame).receipt
  return typeof receipt === 'object' && receipt !== null ? (receipt as Frame) : null
}

/** 回执里的 `result.ports` / `result.applied` 都是"有就用、没有就当空"，不猜形状。 */
function listOf(holder: Frame | null | undefined, key: string): unknown[] {
  const value = holder?.[key]
  return Array.isArray(value) ? value : []
}

export function useArmManifest(): ArmManifestView {
  // 臂身份用 join 出来的字符串做比较键：`vrBridge.arms` 每次都是新数组，
  // 直接当快照交给 useSyncExternalStore 会一直重渲染（同 `useArmLoads`）。
  const armKey = useSyncExternalStore(vrBridge.subscribe, () => vrBridge.arms.join('\u0000'))
  // 能不能改只取决于这两件事，所以各自按布尔值订阅 —— 快照每 100ms 换一次引用，
  // 整份订阅会让这张卡跟着一起重渲染。
  const online = useSyncExternalStore(vrBridge.subscribe, () => vrBridge.online)
  const following = useSyncExternalStore(
    vrBridge.subscribe,
    () => vrBridge.snapshot?.headset?.following === true,
  )

  const [rows, setRows] = useState<ArmManifestRow[]>([])
  const [ports, setPorts] = useState<PortCandidate[]>([])
  const [portsError, setPortsError] = useState<string | null>(null)
  const [loadingPorts, setLoadingPorts] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string[] | null>(null)
  const [portTick, setPortTick] = useState(0)

  useEffect(() => {
    const sample = () => setRows(readArmManifest(vrBridge))
    sample()
    const timer = setInterval(sample, SAMPLE_MS)
    return () => clearInterval(timer)
  }, [armKey])

  useEffect(() => {
    if (!online) return
    let dropped = false
    setLoadingPorts(true)
    vrBridge.listPorts().then(
      (value) => {
        if (dropped) return
        const receipt = asReceipt(value)
        setPorts(
          listOf(receipt?.result as Frame | undefined, 'ports')
            .map((entry) => {
              const row = entry as Frame
              return typeof row?.path === 'string'
                ? { path: row.path, kind: typeof row.kind === 'string' ? row.kind : '' }
                : null
            })
            .filter((row): row is PortCandidate => row !== null),
        )
        setPortsError(null)
        setLoadingPorts(false)
      },
      (err: unknown) => {
        if (dropped) return
        // ⚠ **保留上一次列到的口**：列不出来只说明"这一次问不着"（桥刚起来、daemon 在重连），
        //   不等于机器上没有设备。清空的话连"看一眼现在有哪些口"都做不到了。
        setPortsError(messageOf(err))
        setLoadingPorts(false)
      },
    )
    return () => {
      dropped = true
    }
  }, [online, portTick])

  const refreshPorts = useCallback(() => setPortTick((n) => n + 1), [])

  const pending = useRef(0)
  const save = useCallback((devices: Record<string, string>) => {
    const seq = (pending.current += 1)
    setSaving(true)
    setError(null)
    setSaved(null)
    vrBridge.setArmDevices(devices).then(
      (value) => {
        if (seq !== pending.current) return
        setSaving(false)
        const receipt = asReceipt(value)
        setSaved(listOf(receipt?.result as Frame | undefined, 'applied').map(String))
      },
      (err: unknown) => {
        if (seq !== pending.current) return
        // 桥拒绝时 daemon 把它的原话放进 `err`（同一个口给了两条臂、跟随服务还在跑…）：
        // 原样显示，不翻成"保存失败"这种什么都没说的句子
        setSaving(false)
        setError(messageOf(err))
      },
    )
  }, [])

  return {
    rows,
    ports,
    portsError,
    loadingPorts,
    saving,
    error,
    saved,
    canEdit: online && !following,
    refreshPorts,
    save,
  }
}
