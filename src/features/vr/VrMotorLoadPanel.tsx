import { useTranslation } from 'react-i18next'
import { Activity } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { DEFAULT_JOINT_COUNT, jointIndexes } from '@/lib/arm'
import type { ArmLoadView, LoadRow } from './useArmLoads'

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

/**
 * 电机负载表（照 OpenArmX 负载监控那张图）：**每条臂一段**，每段：臂身份与设备名 →
 * 电机 / 实时负载条 / 当前 / 本次峰值，末尾一行是夹爪。
 *
 * 数据来自**真机状态**（`vr_arm` / `vr_grip`，上游汇总服务发的），不是上位机那条
 * 本机串口链路 —— VR 遥操时串口在跟随服务手里，那一路是死的，见 `useArmLoads`。
 * 唯一还走 daemon 的是额定力矩 `tau_max`：那是设备侧静态参数，不是实时读数。
 *
 * 没有读数的那一段（真机状态还没到，或跟随服务自己报了断开）照常摆出整张表：
 * 空条 + "—"，并在段头写明是"未连接"还是"没数据"。空条与"负载为 0"必须看得出区别。
 */
export function VrMotorLoadPanel({
  arms,
  rated,
}: {
  /** 按 `vrBridge.arms` 排出来的一条条臂（单臂一条、双臂两条） */
  arms: ArmLoadView[]
  /** 逐轴额定力矩；null = 没读到（界面不编百分比） */
  rated: (number | null)[] | null
}) {
  const { t } = useTranslation('vr')

  // 没有读数的那几段按"有读数那一臂的轴数"摆空位（同一台机器两臂同构），
  // 一条臂都没读到就按内置轴数 —— 摆的是位置，不编数
  const placeholderRows =
    arms.find((arm) => arm.joints.length > 0)?.joints.length ?? DEFAULT_JOINT_COUNT

  return (
    <Card className="min-h-0 flex-1 gap-2.5 overflow-y-auto rounded-[0.875rem] px-3.5 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[0.90625rem] font-semibold text-foreground">
          <Activity size="0.9375rem" /> {t('load.title')}
        </div>
        <div className="text-[0.6875rem] text-muted-foreground">{t('load.source')}</div>
      </div>

      {arms.length === 0 ? (
        // 桥一条臂都没报：没有可监控的量。这里**不**摆空表 —— 一行行空条会被读成
        // "还没接线"或"负载都是 0"，而成因是这段数据本身没到
        <div className="rounded-[0.625rem] border border-line-soft px-2.5 py-2 text-[0.75rem] text-ink-subtle">
          {t('load.noArms')}
        </div>
      ) : (
        arms.map((arm) => (
          <ArmSection key={arm.arm} arm={arm} rated={rated} placeholderRows={placeholderRows} />
        ))
      )}
    </Card>
  )
}

function ArmSection({
  arm,
  rated,
  placeholderRows,
}: {
  arm: ArmLoadView
  rated: (number | null)[] | null
  /** 这段没有读数时摆几行空位 */
  placeholderRows: number
}) {
  const { t } = useTranslation('vr')
  const rowCount = arm.joints.length || placeholderRows
  // 断开与"没收到过"要分开说：前者的责任在跟随服务那一侧，后者是这一帧还没来
  const state =
    arm.status === 'offline' ? t('load.offline') : arm.status === 'missing' ? t('load.noData') : null

  return (
    <div
      data-testid="load-arm"
      data-arm={arm.arm}
      data-status={arm.status}
      className="flex flex-col gap-1.5 rounded-[0.625rem] border border-line-soft px-2.5 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        {/* 臂身份与设备名：双臂时一眼分得清这两段说的是哪条臂 */}
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-[0.78125rem] font-semibold text-foreground">{arm.arm}</span>
          {arm.device ? (
            <span className="truncate font-mono text-[0.65625rem] text-ink-muted">{arm.device}</span>
          ) : null}
        </div>
        {state ? (
          <div className="flex-none text-[0.6875rem]" style={{ color: 'var(--ink-subtle)' }}>
            {state}
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
          <MotorRow key={i} name={`J${i + 1}`} row={arm.joints[i] ?? null} rated={rated?.[i] ?? null} />
        ))}
        <MotorRow name={t('load.gripper')} row={arm.gripper} rated={null} />
      </div>
    </div>
  )
}

/** 一行读数：没有读数的那一行照画空条（条里写"—"），与"负载为 0"分得开。 */
function MotorRow({ name, row, rated }: { name: string; row: LoadRow | null; rated: number | null }) {
  const { t } = useTranslation('vr')

  if (!row || row.tau === null) {
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
  // 峰值只涨不落；万一这一拍没带上峰值，用当前值兜底也好过空一列
  const peak = row.peak ?? abs
  const ratedValue = rated !== null && rated > 0 ? rated : null
  const ratio = ratedValue === null ? null : abs / ratedValue
  // 刻度取"额定与本次峰值里的大者"：额定线才是条上的标线，超出额定时也画得下
  const scale = Math.max(ratedValue ?? 0, peak, abs, 1e-6)
  const fillPct = Math.min(100, (abs / scale) * 100)
  const tickPct = ratedValue === null ? null : (ratedValue / scale) * 100
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
          {abs.toFixed(2)} / {ratedValue === null ? t('load.noRated') : `${ratedValue.toFixed(0)} N·m`}
        </div>
      </div>

      <div className="w-[6.25rem] flex-none text-right font-mono text-[0.6875rem] text-foreground">
        {row.tau.toFixed(2)} N·m
        {ratio === null ? '' : ` (${Math.round(ratio * 100)}%)`}
      </div>
      <div
        title={tempHint(row, t)}
        className="w-[5rem] flex-none text-right font-mono text-[0.6875rem] text-ink-muted"
      >
        {peak.toFixed(2)} N·m
      </div>
    </div>
  )
}

/**
 * 温度的悬停文本（没有温度时为 undefined）。
 *
 * 每轴再多一行会把这张卡撑爆（双臂就是 16 行），而温度是"看一眼趋势"的量：挂在"本次峰值"
 * 那一格上，鼠标停上去就有。
 */
function tempHint(row: LoadRow, t: (key: string) => string): string | undefined {
  const parts: string[] = []
  if (row.tMos != null) parts.push(`${t('load.tempMos')} ${row.tMos.toFixed(1)} ℃`)
  if (row.tCoil != null) parts.push(`${t('load.tempCoil')} ${row.tCoil.toFixed(1)} ℃`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}
