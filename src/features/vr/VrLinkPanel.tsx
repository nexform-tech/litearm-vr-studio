import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Glasses, TriangleAlert } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/Pill'
import { StatCard } from '@/components/StatCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { VrLinkView } from './useVrLink'
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

export function VrLinkPanel({ vm }: { vm: VrLinkView }) {
  const { t } = useTranslation('vr')
  const [endpoint, setEndpoint] = useState(vm.bridgeEndpoint)

  const live = vm.headsetOnline
  const style = stateStyle(vm.linkState, live)
  const stateLabel =
    vm.linkState === 'fallback'
      ? t('link.stateFallback')
      : !live
        ? t('link.stateOffline')
        : vm.following
          ? t('link.stateFollowing')
          : vm.linkState === 'latched'
            ? t('link.stateLatched')
            : t('link.stateReady')

  // 转发耗时是这个服务自己的开销：正常应 < 1ms，变大说明桥卡了（DESIGN 6.2）
  const costWarn = vm.forwardCostMs >= 1
  const stats = [
    { k: t('link.statFps'), v: live ? vm.fps.toFixed(0) : '—', u: live ? 'Hz' : '', c: live ? 'var(--ink)' : 'var(--ink-faint)' },
    { k: t('link.statLatency'), v: live ? vm.latencyMs.toFixed(0) : '—', u: live ? 'ms' : '', c: live ? 'var(--ink)' : 'var(--ink-faint)' },
    {
      k: t('link.statSinceFrame'),
      // 桥还没收到过帧时它发 null，这里显示 "—" 而不是假的 0
      v: vm.frames > 0 ? String(vm.sinceFrameMs) : '—',
      u: vm.frames > 0 ? 'ms' : '',
      c: live ? 'var(--ink)' : 'var(--danger)',
    },
    { k: t('link.statFrames'), v: vm.framesForwarded.toLocaleString('en-US'), u: '', c: 'var(--ink)' },
  ]

  const hops = [
    {
      name: t('link.headsetName'),
      addr: t('link.headsetAddr'),
      detail: live ? `${vm.fps.toFixed(0)} Hz` : t('link.diagOff'),
      active: live,
    },
    {
      name: t('link.bridgeName'),
      // 桥地址是操作员填的，端口跟着现场走：写死 "ws 8765" 会在桥不在 8765 时骗人
      addr: hostPortOf(vm.bridgeEndpoint) || t('link.addrUnset'),
      detail: vm.bridgeOnline ? `${vm.forwardCostMs.toFixed(2)} ms` : t('link.diagOff'),
      active: vm.bridgeOnline,
    },
    {
      name: t('link.relayName'),
      addr: t('link.relayAddr'),
      detail: vm.metavrConnected ? t('link.diagOn') : t('link.diagOff'),
      active: vm.metavrConnected,
    },
    {
      name: t('link.followName'),
      addr: t('link.followAddr'),
      detail: vm.armConnected ? (vm.armState ?? t('link.diagOn')) : t('link.diagOff'),
      active: vm.armConnected,
    },
    {
      name: t('link.armName'),
      // 桥没连上时，"仿真还是真机"这一格无从判断：写"仿真"是个我们保不了的断言
      addr: !vm.bridgeOnline
        ? t('link.addrUnset')
        : vm.armSource === 'real'
          ? t('link.armAddrReal')
          : t('link.armAddrSim'),
      detail: !vm.bridgeOnline
        ? t('link.diagOff')
        : vm.armSource === 'real'
          ? t('link.armSubReal')
          : t('link.armSubSim'),
      active: vm.bridgeOnline && vm.armSource === 'real' && vm.following,
    },
  ]

  return (
    <Card className="gap-3 rounded-[0.875rem] px-3.5 py-3.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[0.90625rem] font-semibold text-foreground">
          <Glasses size="0.9375rem" /> {t('link.title')}
        </div>
        <Pill dot={style.dot} bg={style.bg} bd={style.bd} fg={style.fg} padding="0.1875rem 0.625rem" fontSize={11.5}>
          {stateLabel}
        </Pill>
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

      {!vm.fallbackGuardEnabled ? (
        <div className="rounded-[0.625rem] border border-warn-line bg-warn-soft px-2.5 py-2 text-[0.71875rem] text-warn">
          {t('link.guardOff')}
        </div>
      ) : null}

      {vm.rearmRequired && !vm.fallbackActive ? (
        <div className="rounded-[0.625rem] border border-warn-line bg-warn-soft px-2.5 py-2 text-[0.71875rem] text-warn">
          {t('link.rearmHint')}
        </div>
      ) : null}

      {/* 数据源：只有真实桥一路。连不上就是连不上，没有兜底数据 */}
      <div
        className="flex items-center justify-between gap-2 rounded-[0.625rem] border px-2.5 py-2"
        style={{
          borderColor: vm.bridgeOnline ? 'var(--ok-line)' : 'var(--line)',
          background: vm.bridgeOnline ? 'var(--ok-soft)' : 'transparent',
        }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <div
            className="size-[0.4375rem] flex-none rounded-full"
            style={{ background: vm.bridgeOnline ? OK : IDLE }}
          />
          <div className="truncate text-[0.75rem] font-semibold text-foreground">
            {vm.bridgeOnline ? t('link.sourceBridge') : t('link.sourceOffline')}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2 font-mono text-[0.625rem] text-ink-muted">
          {vm.bridgeOnline && vm.bridgeVersion ? <span>v{vm.bridgeVersion}</span> : null}
          {vm.bridgeOnline ? <span>{formatUptime(vm.bridgeUptimeS)}</span> : null}
        </div>
      </div>

      {/* 链路逐跳：头显 → 桥 → metavr → 跟随服务 → 机械臂 */}
      <div className="flex flex-col gap-1">
        {hops.map((hop) => (
          <div key={hop.name} className="flex items-center gap-2 rounded-[0.5rem] px-1.5 py-1 odd:bg-muted/40">
            <div
              className="size-[0.4375rem] flex-none rounded-full"
              style={{ background: hop.active ? OK : IDLE }}
            />
            <div className="w-[7.5rem] flex-none truncate text-[0.75rem] font-semibold text-foreground">
              {hop.name}
            </div>
            <div className="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-ink-muted">
              {hop.addr}
            </div>
            <div
              className="flex-none truncate text-[0.6875rem]"
              style={{ color: hop.active ? 'var(--ok)' : 'var(--ink-subtle)' }}
            >
              {hop.detail}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-2">
        {stats.map((m) => (
          <StatCard key={m.k} k={m.k} v={m.v} u={m.u} valueColor={m.c} valueFontSize={15} />
        ))}
      </div>

      {/* 桥自身的开销与拦截情况（DESIGN 6.1/6.2） */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard
          k={t('link.statForwardCost')}
          v={vm.bridgeOnline ? vm.forwardCostMs.toFixed(2) : '—'}
          u={vm.bridgeOnline ? 'ms' : ''}
          valueColor={costWarn ? DANGER : 'var(--ink)'}
          valueFontSize={14}
        />
        <StatCard
          k={t('link.statDropped')}
          v={vm.framesDropped}
          u=""
          valueColor={vm.framesDropped > 0 ? WARN : 'var(--ink)'}
          valueFontSize={14}
        />
        <StatCard
          k={t('link.statBlocked')}
          v={vm.framesBlocked}
          u=""
          valueColor={vm.framesBlocked > 0 ? WARN : 'var(--ink)'}
          valueFontSize={14}
        />
      </div>

      {/* 桥地址：每台机器的地址都可能不同，界面上直接改（存本机） */}
      <div className="flex flex-col gap-1.5 rounded-[0.625rem] border border-line-soft px-2.5 py-2">
        <div className="text-[0.6875rem] text-muted-foreground">
          {vm.bridgeConfigured ? t('link.endpointHint') : t('link.endpointUnset')}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-none text-[0.71875rem] font-medium text-ink-strong">
            {t('link.endpointLabel')}
          </div>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') vm.setBridgeEndpoint(endpoint)
            }}
            placeholder={t('link.endpointPlaceholder')}
            spellCheck={false}
            aria-label={t('link.endpointLabel')}
            className="h-7 flex-1 font-mono text-[0.6875rem]"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => vm.setBridgeEndpoint(endpoint)}
            className="h-7 flex-none rounded-[0.5rem] px-2 text-[0.75rem]"
          >
            {t('link.endpointApply')}
          </Button>
        </div>
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

/** `ws://host:8765/ws/status` → `host:8765`（逐跳那一列只放得下这么多） */
function hostPortOf(endpoint: string): string {
  const withoutScheme = endpoint.replace(/^wss?:\/\//i, '')
  return withoutScheme.split('/', 1)[0] ?? ''
}
