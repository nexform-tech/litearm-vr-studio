import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { DEFAULT_JOINT_COUNT, jointIndexes } from '@/lib/arm'
import { readMotorTopics, saveMotorTopics, type MotorTopics } from './motorTopics'
import type { MotorLoad } from './useMotorLoad'

/**
 * 条的配色。
 *
 * 条本身是一块**深色仪表面**（照原图：深底、白字、白线标额定），所以这里的语义色按
 * 深底调过，不直接套主题里那套浅底语义色（#137a44 这类压在深底上会糊）。
 */
const TRACK = '#1b2430'
const LEVEL_COLOR = {
  ok: '#2fa15e',
  warn: '#d9a23b',
  danger: '#dd5353',
  unknown: '#5c6b7f',
} as const

/** 档位同时挂成 `data-level`：颜色可以改，档位的含义不该跟着变 */
export type LoadLevel = keyof typeof LEVEL_COLOR

/**
 * 负载分档：≤85% 额定为绿，85–100% 为黄，超额定为红。
 *
 * 原图的口径是"绿 ≤额定 / 黄 >额定 / 红 ≥85% 峰值"，其中"峰值"指电机的峰值扭矩额定。
 * 我们手上只有 SDK 的 `tau_max`（就是峰值上限），没有第二个"额定连续"值，所以这里
 * 用 tau_max 一档到底。分档只在代码里这一处，界面上不写图例。
 */
function loadLevel(ratio: number | null): LoadLevel {
  if (ratio === null) return 'unknown'
  if (ratio > 1) return 'danger'
  if (ratio >= 0.85) return 'warn'
  return 'ok'
}

/** 一条臂的读数；`live` 为真时才画表，否则只说"未连接" */
export type ArmLoadTable = {
  live: boolean
  rows: MotorLoad[]
  /** 夹爪的读数；null = 还没接线，表里那一行如实写"未接线" */
  gripper?: MotorLoad | null
}

/**
 * 电机负载表（照 OpenArmX 负载监控那张图）：数据话题 → 图例 → 左右臂各一段，
 * 每段：电机 / 实时负载条 / 当前 / 本次峰值，末尾一行是夹爪。
 *
 * 数据来自上位机链路（daemon），不是桥：桥不报扭矩（见 `useMotorLoad`）。
 * 双臂接线还没定，但**没有数据的那一侧照常摆出整张表**（空条 + "—"）：位置先固定下来，
 * 接线到了数就落进同一批行。空条与"负载为 0"必须看得出区别，所以空条里写的是"—"。
 */
export function VrMotorLoadPanel({ left, right }: { left: ArmLoadTable; right: ArmLoadTable }) {
  const { t } = useTranslation('vr')
  const [topics, setTopics] = useState<MotorTopics>(readMotorTopics)
  const [applied, setApplied] = useState(false)

  const edit = (key: keyof MotorTopics) => (value: string) => {
    setTopics((prev) => ({ ...prev, [key]: value }))
    setApplied(false)
  }

  const topicRows: { key: keyof MotorTopics; label: string }[] = [
    { key: 'leftArm', label: t('load.topicLeftArm') },
    { key: 'rightArm', label: t('load.topicRightArm') },
    { key: 'leftGripper', label: t('load.topicLeftGripper') },
    { key: 'rightGripper', label: t('load.topicRightGripper') },
  ]

  // 没有数据的一侧摆几行：跟有数据那一侧的轴数走（同一台机器两臂同构），
  // 两侧都没有时按内置轴数摆空位 —— 不编数，只摆位置
  const placeholderCount = (rows: number) => rows || DEFAULT_JOINT_COUNT

  return (
    <Card className="min-h-0 flex-1 gap-2.5 overflow-y-auto rounded-[0.875rem] px-3.5 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[0.90625rem] font-semibold text-foreground">
          <Activity size="0.9375rem" /> {t('load.title')}
        </div>
        <div className="text-[0.6875rem] text-muted-foreground">{t('load.source')}</div>
      </div>

      {/* 数据话题：四个遥测话题名。接线未定，所以这里只存本机，不接任何东西 */}
      <div className="flex flex-col gap-1.5 rounded-[0.625rem] border border-line-soft px-2.5 py-2">
        <div className="text-[0.78125rem] font-semibold text-foreground">{t('load.topicsTitle')}</div>
        {topicRows.map((row) => (
          <div key={row.key} className="flex items-center gap-2">
            <div className="w-[6.5rem] flex-none text-[0.6875rem] text-muted-foreground">{row.label}</div>
            <Input
              value={topics[row.key]}
              onChange={(e) => edit(row.key)(e.target.value)}
              spellCheck={false}
              aria-label={row.label}
              className="h-7 min-w-0 flex-1 font-mono text-[0.6875rem]"
            />
          </div>
        ))}
        <div className="flex items-center justify-between gap-2">
          {/* 存下来的反馈留在左边，按钮靠右 */}
          <div className="text-[0.65625rem] text-muted-foreground">
            {applied ? t('load.topicSaved') : ''}
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              saveMotorTopics(topics)
              setApplied(true)
            }}
            className="h-7 flex-none rounded-[0.5rem] px-3 text-[0.75rem]"
          >
            {t('load.topicApply')}
          </Button>
        </div>
      </div>

      <ArmSection label={t('load.armLeft')} table={left} placeholderRows={placeholderCount(right.rows.length)} />
      <ArmSection label={t('load.armRight')} table={right} placeholderRows={placeholderCount(left.rows.length)} />
    </Card>
  )
}

function ArmSection({
  label,
  table,
  placeholderRows,
}: {
  label: string
  table: ArmLoadTable
  /** 这一侧没有读数时摆几行空位 */
  placeholderRows: number
}) {
  const { t } = useTranslation('vr')
  const rowCount = table.rows.length || placeholderRows

  return (
    <div className="flex flex-col gap-1.5 rounded-[0.625rem] border border-line-soft px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[0.78125rem] font-semibold text-foreground">{label}</div>
        {!table.live ? (
          <div className="text-[0.6875rem]" style={{ color: 'var(--ink-subtle)' }}>
            {t('load.offline')}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 px-1.5 text-[0.65625rem] text-muted-foreground">
        <div className="w-7 flex-none">{t('load.colMotor')}</div>
        <div className="min-w-0 flex-1">{t('load.colBar')}</div>
        <div className="w-[6.25rem] flex-none text-right">{t('load.colNow')}</div>
        <div className="w-[5rem] flex-none text-right">{t('load.colPeak')}</div>
      </div>

      <div className="flex flex-col gap-1">
        {jointIndexes(rowCount).map((i) => (
          <LoadRow key={i} name={`J${i + 1}`} row={table.rows[i] ?? null} />
        ))}
        <LoadRow name={t('load.gripper')} row={table.gripper ?? null} />
      </div>
    </div>
  )
}

function LoadRow({ name, row }: { name: string; row: MotorLoad | null }) {
  const { t } = useTranslation('vr')

  // 没有读数的那一行：条照画，但不画填充，条里写"—" —— 空条与"负载为 0"要分得开
  if (!row) {
    return (
      <div className="flex items-center gap-2 rounded-[0.4375rem] px-1.5 py-1 odd:bg-muted/40">
        <div className="w-7 flex-none truncate font-mono text-[0.75rem] font-semibold text-foreground">
          {name}
        </div>
        <div
          data-testid="load-track"
          className="relative flex h-[1.125rem] min-w-0 flex-1 items-center overflow-hidden rounded-[0.3125rem] px-1.5"
          style={{ background: TRACK }}
        >
          <span className="font-mono text-[0.625rem] font-semibold text-white/60">—</span>
        </div>
        <div className="w-[6.25rem] flex-none text-right font-mono text-[0.6875rem] text-ink-faint">—</div>
        <div className="w-[5rem] flex-none text-right font-mono text-[0.6875rem] text-ink-faint">—</div>
      </div>
    )
  }

  const abs = Math.abs(row.tau)
  const rated = row.rated !== null && row.rated > 0 ? row.rated : null
  const ratio = rated === null ? null : abs / rated
  // 刻度取"额定与本次峰值里的大者"：额定线才是条上的标线，超出额定时也画得下
  const scale = Math.max(rated ?? 0, row.peak, abs, 1e-6)
  const fillPct = Math.min(100, (abs / scale) * 100)
  const tickPct = rated === null ? null : (rated / scale) * 100
  const level = loadLevel(ratio)

  return (
    <div className="flex items-center gap-2 rounded-[0.4375rem] px-1.5 py-1 odd:bg-muted/40">
      <div className="w-7 flex-none truncate font-mono text-[0.75rem] font-semibold text-foreground">
        {name}
      </div>

      <div
        className="relative h-[1.125rem] min-w-0 flex-1 overflow-hidden rounded-[0.3125rem]"
        style={{ background: TRACK }}
      >
        <div
          data-testid="load-fill"
          data-level={level}
          className="absolute inset-y-0 left-0"
          style={{ width: `${fillPct}%`, background: LEVEL_COLOR[level] }}
        />
        {tickPct === null ? null : (
          // 额定负载标线：深底上的白线（原图口径）
          <div
            data-testid="load-tick"
            className="absolute inset-y-0 w-[0.0625rem] bg-white/70"
            style={{ left: `${tickPct}%` }}
          />
        )}
        {/* 条上写"|当前| / 额定"，白字压在深底与色条上都读得出来 */}
        <div className="absolute inset-y-0 left-1.5 flex items-center font-mono text-[0.625rem] font-semibold text-white">
          {abs.toFixed(2)} / {rated === null ? t('load.noRated') : `${rated.toFixed(0)} N·m`}
        </div>
      </div>

      <div className="w-[6.25rem] flex-none text-right font-mono text-[0.6875rem] text-foreground">
        {row.tau.toFixed(2)} N·m
        {ratio === null ? '' : ` (${Math.round(ratio * 100)}%)`}
      </div>
      <div className="w-[5rem] flex-none text-right font-mono text-[0.6875rem] text-ink-muted">
        {row.peak.toFixed(2)} N·m
      </div>
    </div>
  )
}
