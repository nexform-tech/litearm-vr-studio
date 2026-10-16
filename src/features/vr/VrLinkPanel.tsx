import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Glasses, TriangleAlert } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/Pill'
import { StatCard } from '@/components/StatCard'
import type { VrLinkView } from './useVrLink'
import { bridgeCompat, SUPPORTED_BRIDGE_VERSION } from './bridgeCompat'
import { formatArmFault, type VrArmView } from './vrLink'
import type { VrLinkState } from './vrTypes'

const OK = '#137a44'
const WARN = '#b0740f'
const DANGER = '#c8323a'
const IDLE = '#9aa6b6'

/**
 * 链路状态 → 徽标配色。
 *
 * 兜底优先于"头显离线"：兜底**就是**因为没帧才触发的，此时头显必然判离线，
 * 但页面必须让操作员看到"兜底持位"这件事（红色），而不是一句"未连接"。
 */
function stateStyle(state: VrLinkState, live: boolean) {
  if (state === 'fallback') {
    return { dot: DANGER, bg: 'var(--danger-soft)', bd: 'var(--danger-line)', fg: 'var(--danger)' }
  }
  if (!live) return { dot: IDLE, bg: 'var(--line-soft)', bd: 'var(--line)', fg: 'var(--ink-subtle)' }
  if (state === 'following') {
    return { dot: OK, bg: 'var(--ok-soft)', bd: 'var(--ok-line)', fg: 'var(--ok)' }
  }
  return { dot: WARN, bg: 'var(--warn-soft)', bd: 'var(--warn-line)', fg: 'var(--warn)' }
}

/**
 * 链路卡：整条链路的通断与开销（头显 → 桥 → 逆解 → 跟随服务 → 机械臂），外加遥操
 * 状态机与兜底。
 *
 * 逐臂的画面在这里只出现一处：桥认到**两条以上**臂时的逐臂状态条（跟随态与故障是每条臂
 * 各自的，挤成一份会让人以为两条臂是一个状态）。其余字段（帧率、桥开销、归属）本来就是
 * 整机的，按一条臂画没有意义。
 */
export function VrLinkPanel({ vm }: { vm: VrLinkView }) {
  const { t } = useTranslation('vr')

  // 桥报的版本对不对得上这版页面（补丁号不算），见 bridgeCompat
  const compat = bridgeCompat(vm.bridgeVersion)

  const live = vm.headsetOnline
  const style = stateStyle(vm.linkState, live)
  /**
   * 徽标只报遥操状态机那一档（跟随中 / 持位 / 兜底），**不报通断**：
   * 哪一跳没连上是流程条上那一格自己的事，同一个"未连接"在一张卡片里说两遍只会让人
   * 怀疑它们不是一个意思。桥不在时没有状态可报，徽标整个不出现。
   */
  const stateLabel = !vm.bridgeOnline
    ? null
    : vm.linkState === 'fallback'
      ? t('link.stateFallback')
      : vm.following
        ? t('link.stateFollowing')
        : vm.linkState === 'latched'
          ? t('link.stateLatched')
          : t('link.stateReady')

  // 转发耗时是这个服务自己的开销：正常应 < 1ms，变大说明桥卡了（DESIGN 6.2）
  const costWarn = vm.forwardCostMs >= 1
  const linkStats = [
    { k: t('link.statFps'), v: live ? vm.fps.toFixed(0) : '—', u: live ? 'Hz' : '', c: live ? 'var(--ink)' : 'var(--ink-faint)' },
    {
      // 头显时钟与上位机不可比时（latency_estimated），桥报的是"相对窗口内最小值的增量"，
      // 不是一个绝对延迟：口径得跟着数字一起换，否则会被读成"链路只有 3ms"
      k: vm.latencyEstimated ? t('link.statLatencyEstimated') : t('link.statLatency'),
      v: live ? vm.latencyMs.toFixed(0) : '—',
      u: live ? 'ms' : '',
      c: live ? 'var(--ink)' : 'var(--ink-faint)',
    },
    {
      k: t('link.statSinceFrame'),
      // 桥还没收到过帧时它发 null，这里显示 "—" 而不是假的 0
      v: vm.frames > 0 ? String(vm.sinceFrameMs) : '—',
      u: vm.frames > 0 ? 'ms' : '',
      c: live ? 'var(--ink)' : 'var(--danger)',
    },
    { k: t('link.statFrames'), v: vm.framesForwarded.toLocaleString('en-US'), u: '', c: 'var(--ink)' },
  ]
  // 桥自身的开销与拦截情况（DESIGN 6.1/6.2）
  const bridgeStats = [
    {
      k: t('link.statForwardCost'),
      v: vm.bridgeOnline ? vm.forwardCostMs.toFixed(2) : '—',
      u: vm.bridgeOnline ? 'ms' : '',
      c: costWarn ? DANGER : 'var(--ink)',
    },
    { k: t('link.statDropped'), v: vm.framesDropped, u: '', c: vm.framesDropped > 0 ? WARN : 'var(--ink)' },
    { k: t('link.statBlocked'), v: vm.framesBlocked, u: '', c: vm.framesBlocked > 0 ? WARN : 'var(--ink)' },
  ]

  /**
   * 链路逐跳，按数据流方向排：头显 → 桥 → metavr → 跟随服务 → 机械臂。
   * 每跳只报两件事：这一跳通没通、它自己的开销是多少 —— 端口与地址是各服务的配置，
   * 不是这一页要看的状态。
   */
  const hops = [
    { name: t('link.headsetName'), detail: live ? `${vm.fps.toFixed(0)} Hz` : t('link.diagOff'), active: live },
    {
      name: t('link.bridgeName'),
      detail: vm.bridgeOnline ? `${vm.forwardCostMs.toFixed(2)} ms` : t('link.diagOff'),
      active: vm.bridgeOnline,
    },
    {
      name: t('link.relayName'),
      detail: vm.metavrConnected ? t('link.diagOn') : t('link.diagOff'),
      active: vm.metavrConnected,
    },
    {
      name: t('link.followName'),
      detail: vm.armConnected ? (vm.armState ?? t('link.diagOn')) : t('link.diagOff'),
      active: vm.armConnected,
    },
    {
      name: t('link.armName'),
      // "仿真还是真机"这一格只说得出两种：真机（跟随服务正连着）与**不知道**。
      // ⚠ 别把"不知道"写成"仿真姿态" —— 那是我们保不了的断言，而这正是以前的样子：
      //   桥那份快照里的来源字段早就不发了，于是这一格无论现场在跑什么都说"仿真"。
      //   （`sim` 这一档留着：哪天上游重新报仿真/真机，这里接上就行。）
      detail: !vm.bridgeOnline
        ? t('link.diagOff')
        : vm.armSource === 'real'
          ? t('link.armSubReal')
          : vm.armSource === 'sim'
            ? t('link.armSubSim')
            : t('link.armSubUnknown'),
      active: vm.bridgeOnline && vm.armSource === 'real' && vm.following,
    },
  ]

  return (
    // 按内容取自然高度：中列余下的高度归 3D 预览（见 VrConsole）
    <Card className="gap-3 rounded-[0.875rem] px-3.5 py-3.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[0.90625rem] font-semibold text-foreground">
          <Glasses size="0.9375rem" /> {t('link.title')}
        </div>
        {stateLabel ? (
          <Pill dot={style.dot} bg={style.bg} bd={style.bd} fg={style.fg} padding="0.1875rem 0.625rem" fontSize={11.5}>
            {stateLabel}
          </Pill>
        ) : null}
      </div>

      {/* 兜底：本项目最重要的安全状态，必须一眼看见 */}
      {vm.fallbackActive ? (
        <div className="flex items-start gap-2 rounded-[0.625rem] border border-danger-line bg-danger-soft px-2.5 py-2">
          <TriangleAlert size="0.9375rem" className="mt-[0.0625rem] flex-none text-danger" />
          <div className="min-w-0">
            <div className="text-[0.78125rem] font-semibold text-danger">{t('link.fallbackTitle')}</div>
            <div className="text-[0.6875rem] leading-relaxed text-danger/85">
              {t('link.fallbackBody', { ms: vm.fallbackMs.toFixed(0) })}
              {vm.fallbackReason ? (
                <span className="ml-1 font-mono opacity-80">
                  {t('link.fallbackReasonLabel')}: {vm.fallbackReason}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* 跟随服务报的故障码：这是**设备**在说它有事，排在那几条"提醒"前面。
          双臂时故障按臂分开报（见下面那一段），这里只报单臂部署那一条 */}
      {vm.arms.length <= 1 && vm.armFault && vm.armFault.length > 0 ? (
        <div
          data-testid="vr-arm-fault"
          className="flex items-start gap-2 rounded-[0.625rem] border border-danger-line bg-danger-soft px-2.5 py-2"
        >
          <TriangleAlert size="0.9375rem" className="mt-[0.0625rem] flex-none text-danger" />
          <div className="min-w-0">
            <div className="text-[0.78125rem] font-semibold text-danger">
              {t('link.faultTitle', { count: vm.armFault.length })}
            </div>
            {/* 原样显示：两个版本的跟随服务报的不是一回事（见 vrLink 的 formatArmFault） */}
            <div className="mt-0.5 font-mono text-[0.6875rem] leading-relaxed break-words text-danger/85">
              {vm.armFault.map(formatArmFault).join('  ')}
            </div>
          </div>
        </div>
      ) : null}

      {!vm.fallbackGuardEnabled ? (
        <div className="rounded-[0.625rem] border border-warn-line bg-warn-soft px-2.5 py-2 text-[0.71875rem] text-warn">
          {t('link.guardOff', { ms: vm.fallbackMs.toFixed(0) })}
        </div>
      ) : null}

      {vm.rearmRequired && !vm.fallbackActive ? (
        <div className="rounded-[0.625rem] border border-warn-line bg-warn-soft px-2.5 py-2 text-[0.71875rem] text-warn">
          {t('link.rearmHint')}
        </div>
      ) : null}

      {/* 与跟随服务之间最后一次失败的原因：它答的正是下面那一跳为什么写着"未连接"。
          桥报的是原始异常串（`TimeoutError: ` 这种，见 bridge 的 follow.py），照实显示。 */}
      {vm.armError ? (
        <div
          data-testid="vr-arm-error"
          className="rounded-[0.625rem] border border-danger-line bg-danger-soft px-2.5 py-2 text-[0.71875rem] break-words text-danger"
        >
          {t('link.armErrorTitle')}: <span className="font-mono">{vm.armError}</span>
        </div>
      ) : null}

      {/* 数据源：只有真实桥一路。这一行讲的是"哪一路、什么版本、跑了多久"，
          桥不在时那三样都没意义 —— 直接不显示，免得和上面那颗徽标各说一句"未连接" */}
      {vm.bridgeOnline ? (
        <div
          className="flex items-center justify-between gap-2 rounded-[0.625rem] border px-2.5 py-2"
          style={{ borderColor: 'var(--ok-line)', background: 'var(--ok-soft)' }}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="size-[0.4375rem] flex-none rounded-full" style={{ background: OK }} />
            <div className="truncate text-[0.75rem] font-semibold text-foreground">
              {t('link.sourceBridge')}
            </div>
          </div>
          <div className="flex flex-none items-center gap-2 font-mono text-[0.625rem] text-ink-muted">
            {vm.bridgeVersion ? <span>v{vm.bridgeVersion}</span> : null}
            {/* 版本对不上：链接本身是好的，所以只加一枚徽标，不把这一行改成告警色 */}
            {compat === 'mismatch' ? (
              <span
                data-testid="vr-version-warning"
                className="flex-none rounded-full bg-warn-soft px-1.5 py-0.5 font-sans text-[0.625rem] font-medium text-warn"
                title={t('link.versionMismatchHint', {
                  version: vm.bridgeVersion,
                  supported: SUPPORTED_BRIDGE_VERSION,
                })}
              >
                {t('link.versionMismatch')}
              </span>
            ) : null}
            <span>{formatUptime(vm.bridgeUptimeS)}</span>
          </div>
        </div>
      ) : null}

      {/* 逐跳流程条：五跳横排成一条链，箭头即数据流方向 */}
      <div className="flex items-stretch gap-1">
        {hops.map((hop, i) => (
          <Fragment key={hop.name}>
            {i > 0 ? (
              <div className="flex flex-none items-center text-ink-faint">
                <ChevronRight size="0.75rem" />
              </div>
            ) : null}
            <div
              data-testid="link-hop"
              className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-[0.5rem] border border-line-soft bg-muted/40 px-1 py-1.5"
            >
              <div className="flex min-w-0 max-w-full items-center gap-1">
                <div
                  className="size-[0.375rem] flex-none rounded-full"
                  style={{ background: hop.active ? OK : IDLE }}
                />
                <div className="truncate text-[0.6875rem] font-semibold text-foreground">{hop.name}</div>
              </div>
              <div
                className="w-full truncate text-center font-mono text-[0.65625rem]"
                style={{ color: hop.active ? 'var(--ok)' : 'var(--ink-subtle)' }}
              >
                {hop.detail}
              </div>
            </div>
          </Fragment>
        ))}
      </div>

      {/* 逐臂那一段：**双臂及以上**才出现。
          一条臂时整张卡的字段本来就是它的（控制卡与链路卡共用一个整机视图），再说一遍
          就是"同一句话在一张卡片里说两遍"；两条臂时则必须分开报 —— 跟随态与故障都是每条臂
          各自的，挤成一份会让人以为两条臂是同一个状态。 */}
      {vm.arms.length > 1 ? (
        <div data-testid="vr-arm-rows" className="flex flex-col gap-1.5">
          {vm.arms.map((arm) => (
            <ArmRow key={arm.arm} arm={arm} />
          ))}
        </div>
      ) : null}

      {/* 指标铺底：链路四个在上、桥自身三个在下。卡片余下的高度由 justify-between
          均分到各段之间，指标卡自己保持自然高度（拉高会变成一排空盒子） */}
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-4 gap-2">
          {linkStats.map((m) => (
            <StatCard key={m.k} k={m.k} v={m.v} u={m.u} valueColor={m.c} valueFontSize={15} />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {bridgeStats.map((m) => (
            <StatCard key={m.k} k={m.k} v={m.v} u={m.u} valueColor={m.c} valueFontSize={14} />
          ))}
        </div>

        {live && vm.latencyEstimated ? (
          <div className="text-[0.65625rem] leading-relaxed text-muted-foreground">
            {t('link.statLatencyNote')}
          </div>
        ) : null}
      </div>

    </Card>
  )
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${seconds.toFixed(0)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

/**
 * 一条臂自己的状态：身份、设备名、跟随服务报的状态，以及它的故障与错误。
 *
 * 故障码原样显示（两种形状都要能看，见 `formatArmFault`）：压成"有故障"就再也说不出
 * 是哪个关节、什么错了。
 */
function ArmRow({ arm }: { arm: VrArmView }) {
  const { t } = useTranslation('vr')
  const live = arm.armConnected
  const dot = !live ? IDLE : arm.following ? OK : WARN

  return (
    <div className="flex flex-col gap-1 rounded-[0.625rem] border border-line-soft px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="size-[0.4375rem] flex-none rounded-full" style={{ background: dot }} />
          <span className="truncate text-[0.75rem] font-semibold text-foreground">{arm.arm}</span>
          {arm.device ? (
            <span className="truncate font-mono text-[0.625rem] text-ink-muted">{arm.device}</span>
          ) : null}
        </div>
        <div
          className="flex-none font-mono text-[0.65625rem]"
          style={{ color: live ? 'var(--ok)' : 'var(--ink-subtle)' }}
        >
          {live ? (arm.armState ?? t('link.diagOn')) : t('link.diagOff')}
        </div>
      </div>

      {arm.armFault && arm.armFault.length > 0 ? (
        <div className="font-mono text-[0.65625rem] leading-relaxed break-words text-danger">
          {t('link.armFaults', { count: arm.armFault.length })}:{' '}
          {arm.armFault.map(formatArmFault).join('  ')}
        </div>
      ) : null}

      {arm.armError ? (
        <div className="text-[0.65625rem] break-words text-danger">
          {t('link.armErrorTitle')}: <span className="font-mono">{arm.armError}</span>
        </div>
      ) : null}
    </div>
  )
}
