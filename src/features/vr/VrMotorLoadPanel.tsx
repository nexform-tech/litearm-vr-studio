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

/**
 * 夹爪那一行的底色：蓝色。
 *
 * 为什么不能用灰来区分：这张表里灰（`unknown`）说的是**"读不到额定值、算不出档位"**，而
 * 夹爪没有额定值是它的**常态**，不是没读到。更实际的问题是灰太弱 —— 一行夹爪混在七行关节
 * 里根本看不见，而它恰恰是"这一下夹住了没有、在不在使劲"要看的那一行。
 *
 * 取色与旁边三档同一族：都要压在同一个深色轨道（`TRACK`）上，所以比主题里那个 `--info`
 * 亮一档。蓝只表达"这一行是夹爪"；档位（黄/红）将来有额定值了照旧按它自己的算。
 */
const GRIPPER_COLOR = '#3b82f6'

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
 * 槽位的段头文案。键在这里**写成字面量**（而不是拼 `load.side.${side}`）：静态扫键器
 * 只认字面量，拼出来的键漏翻时页面会直接把键名印给操作员（见 i18n 的守卫用例）。
 */
const SIDE_LABEL = { left: 'load.side.left', right: 'load.side.right' } as const

/**
 * 电机负载表（照 OpenArmX 负载监控那张图）：**两个槽固定摆着 —— 左臂在上、右臂在下**，
 * 每个槽：臂身份与设备名 → 电机 / 实时负载条 / 当前 / 本次峰值，末尾一行是夹爪。
 *
 * 数据来自**真机状态**（`vr_arm` / `vr_grip`，上游汇总服务发的），不是上位机那条
 * 本机串口链路 —— VR 遥操时串口在跟随服务手里，那一路是死的，见 `useArmLoads`。
 * 唯一还走 daemon 的是额定力矩 `tau_max`：那是设备侧静态参数，不是实时读数。
 *
 * 为什么槽位固定、没读数也照摆：结构在不在是"这一页在监控哪两条臂"的说明，缺的只是
 * 格子里的读数。桥没起来、头显没连上时把表收成一句空态，操作员读到的会是"这个功能不在
 * 这台机器上"；而"左臂 / 右臂"两行本身就是操作员找读数的坐标。空槽与"负载为 0"必须
 * 看得出区别：没读数写"—"（空条 + 三格"—"），一格数都不编。
 *
 * 槽里还没认到臂时，段头只有槽位名（"左臂" / "右臂"），臂身份与设备名留空 —— 不写
 * "未认到臂"那种占位话：位置是固定的，认没认到臂由那两处空着说明。
 */
export function VrMotorLoadPanel({
  arms,
  rated,
}: {
  /** 两个槽（左臂在前、右臂在后），可能各是一条臂，也可能空着（见 `useArmLoads`） */
  arms: ArmLoadView[]
  /** 逐轴额定力矩；null = 没读到（界面不编百分比） */
  rated: (number | null)[] | null
}) {
  const { t } = useTranslation('vr')

  // 没有读数的那几个槽按"有读数那一臂的轴数"摆空位（同一台机器两臂同构），
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

      {arms.map((arm) => (
        // 槽位（left / right）是这一段的身份：空槽没有臂身份可当键
        <ArmSection
          key={arm.side || arm.arm}
          arm={arm}
          rated={rated}
          placeholderRows={placeholderRows}
        />
      ))}
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
  // 断开与"没收到过"要分开说：前者的责任在跟随服务那一侧，后者是这一帧还没来。
  // 空槽（这个位置上还没有臂）不叠状态：那一段本来就没有可说的读数
  const state =
    arm.status === 'offline'
      ? t('load.offline')
      : arm.status === 'missing' && arm.arm
        ? t('load.noData')
        : null

  return (
    <div
      data-testid="load-arm"
      data-arm={arm.arm}
      data-side={arm.side}
      data-status={arm.status}
      // 两段臂等分这张卡的高度；`min-h` 是下限 —— 窗口太矮时让卡片自己滚，
      // 而不是把行压扁（那正是这张表最不能发生的事）
      className="flex min-h-[13rem] flex-1 flex-col gap-1.5 rounded-[0.625rem] border border-line-soft px-2.5 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        {/* 槽位名（左臂 / 右臂）是这一段的标题，臂身份与设备名跟在后面 —— 认到臂时三样
            都在，还没认到时只剩槽位名（位置照样摆着，空的只是名字与读数） */}
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="flex-none text-[0.78125rem] font-semibold text-foreground">
            {arm.side ? t(SIDE_LABEL[arm.side]) : arm.arm}
          </span>
          {arm.side && arm.arm ? (
            <span className="flex-none font-mono text-[0.65625rem] text-ink-muted">{arm.arm}</span>
          ) : null}
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

      {/* 行容器单独挂个 testid：用例要断言"骨架里一个数字都没有"，得把段头的设备名排除在外 */}
      {/* 行在段内**均匀铺开**：给满高之后不让余量全堆在底下，8 行 + 夹爪行
          摊在整段上，读数之间也更好分 */}
      <div data-testid="load-rows" className="flex min-h-0 flex-1 flex-col justify-between gap-1">
        {jointIndexes(rowCount).map((i) => (
          <MotorRow key={i} name={`J${i + 1}`} row={arm.joints[i] ?? null} rated={rated?.[i] ?? null} />
        ))}
        <MotorRow name={t('load.gripper')} row={arm.gripper} rated={null} accent="gripper" />
      </div>
    </div>
  )
}

/** 一行读数：没有读数的那一行照画空条（条里写"—"），与"负载为 0"分得开。 */
function MotorRow({
  name,
  row,
  rated,
  accent = 'joint',
}: {
  name: string
  row: LoadRow | null
  rated: number | null
  /** 这一行是关节还是夹爪 —— 只影响颜色，不影响档位（见 `GRIPPER_COLOR`） */
  accent?: 'joint' | 'gripper'
}) {
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
          style={{
            width: `${fillPct}%`,
            // 夹爪没有额定值 ⇒ 档位落在 unknown；那是它的常态，画蓝而不是灰
            background:
              accent === 'gripper' && level === 'unknown'
                ? GRIPPER_COLOR
                : LEVEL_COLOR[level],
          }}
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
