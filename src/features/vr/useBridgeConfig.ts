import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { vrBridge } from './vrDaemonClient'
import type { VrConfigEntry, VrConfigSchema } from './vrTypes'

/**
 * 桥的**配置面**这张卡的数据与动作。
 *
 * 页面**不写死任何键名**：能改哪些键、各自什么取值、改完怎么生效、不给改的为什么，
 * 全是桥下发的（`config.schema`）。所以桥以后新增一个配置项，这边不用改一行 ——
 * 这正是这张卡与"一个功能一套控件"的区别，也是它存在的理由。
 *
 * 三层值要分得开（`entry.source`）：**出厂默认 / `config.toml` 写的 / 上位机改过的**。
 * 覆盖层压过配置文件，所以"改了 config.toml 重启却什么都没变"在桥那边是**正常行为** ——
 * 页面上必须看得见这件事，否则它就是现场最难查的一类问题。
 *
 * 「存了但还没生效」（`pending_restart`，桥那一档要重启才生效）**要如实显示**：
 * 把新值显示成当前值，就是"假装已经生效"。
 */

type Frame = Record<string, unknown>

export type BridgeConfigRow = VrConfigEntry & {
  /** 页面上的当前选择（没动过时 = 桥报的值） */
  draft: unknown
  /** 改过、且与桥报的值不同 */
  dirty: boolean
  /** 这一项来自覆盖层 —— 可以"恢复成 config.toml 的" */
  resetable: boolean
}

export type BridgeConfigView = {
  rows: BridgeConfigRow[]
  loading: boolean
  saving: boolean
  /** 桥拒绝的原话（"不从页面上改"、取值不认、链路忙…），不翻译 */
  error: string | null
  /** 刚刚保存成功的项（空数组 = 没有实际改动） */
  saved: string[] | null
  /** 这次生效不了的项（要重启桥） */
  pendingRestart: string[]
  configFile: string | null
  overridesFile: string | null
  /** 门禁：桥在线、且没有一条臂在跟随（与臂映射卡同一条判据） */
  canEdit: boolean
  /** 重新问桥要一份（别人在另一台上位机上改过时用） */
  refresh: () => void
  set: (path: string, value: unknown) => void
  revert: (path: string) => void
  save: () => void
  reset: (path: string) => void
  dismiss: () => void
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function asReceipt(value: unknown): Frame | null {
  if (typeof value !== 'object' || value === null) return null
  const receipt = (value as Frame).receipt
  return typeof receipt === 'object' && receipt !== null ? (receipt as Frame) : null
}

function listOf(receipt: Frame | null, key: string): string[] {
  const result = receipt?.result
  if (typeof result !== 'object' || result === null) return []
  const value = (result as Frame)[key]
  return Array.isArray(value) ? value.map(String) : []
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** 两个值算不算"同一个"。控件交回来的可能是字符串（"true"），桥报的是布尔。 */
function same(a: unknown, b: unknown): boolean {
  return a === b || String(a) === String(b)
}

/**
 * 读数来源。`vrBridge` 就长这样，测试里换成假的即可。
 */
export type BridgeConfigSource = {
  online: boolean
  loadConfig(): Promise<VrConfigSchema | null>
  setConfig(patch: Record<string, unknown>): Promise<unknown>
  resetConfig(paths: string[]): Promise<unknown>
}

export function useBridgeConfig(): BridgeConfigView {
  const online = useSyncExternalStore(vrBridge.subscribe, () => vrBridge.online)
  // 链路跑着的时候不给改 `respec` 那一档：命令行是启动那一刻冻下来的（判据与臂映射卡
  // 一致，因为理由是同一条）。而 `live` 那一档其实随时能改 —— 但门禁只做一次、
  // 写在一处，比"按档位分别放行"少一类"为什么这个能点那个不能"的现场疑问。
  const following = useSyncExternalStore(
    vrBridge.subscribe,
    () => vrBridge.snapshot?.headset?.following === true,
  )

  const [schema, setSchema] = useState<VrConfigSchema | null>(null)
  const [drafts, setDrafts] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string[] | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    vrBridge.loadConfig().then(
      (next) => {
        setLoading(false)
        setSchema(next)
        // 拉回来的就是最新的：草稿清掉（留着会把"桥已经改了的值"又盖回去）
        setDrafts({})
      },
      (err: unknown) => {
        setLoading(false)
        setError(messageOf(err))
      },
    )
  }, [])

  // 挂载时拉一次；桥从离线变在线时再拉一次（断线时客户端会把那份清掉）
  useEffect(() => {
    if (online) load()
  }, [online, load])

  const rows = useMemo<BridgeConfigRow[]>(() => {
    return (schema?.entries ?? []).map((entry) => {
      const hasDraft = Object.prototype.hasOwnProperty.call(drafts, entry.path)
      const draft = hasDraft ? drafts[entry.path] : entry.value
      return {
        ...entry,
        draft,
        dirty: hasDraft && !same(draft, entry.value),
        resetable: entry.source === 'override',
      }
    })
  }, [schema, drafts])

  const set = useCallback((path: string, value: unknown) => {
    setSaved(null)
    setDrafts((prev) => ({ ...prev, [path]: value }))
  }, [])

  const revert = useCallback((path: string) => {
    setSaved(null)
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
  }, [])

  const dismiss = useCallback(() => setError(null), [])

  // 序号防串台：连点两次保存时，先回来的那一份不该把后一次的结果冲掉
  const pending = useRef(0)
  const run = useCallback((action: () => Promise<unknown>) => {
    const seq = (pending.current += 1)
    setSaving(true)
    setError(null)
    setSaved(null)
    action().then(
      (value) => {
        if (seq !== pending.current) return
        setSaving(false)
        const receipt = asReceipt(value)
        setSaved(listOf(receipt, 'applied'))
        load()
      },
      (err: unknown) => {
        if (seq !== pending.current) return
        // 桥拒绝时 daemon 把它的**原话**放进 `err`（不从页面上改、取值不认、链路忙…）：
        // 原样显示，不翻成"保存失败"这种什么都没说的句子
        setSaving(false)
        setError(messageOf(err))
      },
    )
  }, [load])

  const save = useCallback(() => {
    const changed = rows.filter((row) => row.dirty && row.writable)
    if (!changed.length) return
    // 只送改动过的那几项，且照 `config.toml` 的形状分组（`{"machine": {"real": false}}`）——
    // 桥那边收的就是这个形状，部分更新
    const patch: Record<string, Record<string, unknown>> = {}
    for (const row of changed) {
      patch[row.section] = { ...(patch[row.section] ?? {}), [row.key]: row.draft }
    }
    run(() => vrBridge.setConfig(patch))
  }, [rows, run])

  const reset = useCallback((path: string) => {
    run(() => vrBridge.resetConfig([path]))
  }, [run])

  return {
    rows,
    loading,
    saving,
    error,
    saved,
    pendingRestart: schema?.pending_restart ?? [],
    configFile: str(schema?.config_file),
    overridesFile: str(schema?.overrides_file),
    canEdit: online && !following,
    refresh: load,
    set,
    revert,
    save,
    reset,
    dismiss,
  }
}
