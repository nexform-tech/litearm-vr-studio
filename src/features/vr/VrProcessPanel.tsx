import { useTranslation } from 'react-i18next'
import { Server } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import type { VrLinkView } from './useVrLink'
import type { VrProcessDetail, VrProcessStatus } from './vrTypes'

/** 桥默认托管这两个进程（DESIGN 2.1 / M3） */
const PROCESS_ORDER = ['metavr', 'follow_server']

const STATUS_STYLE: Record<VrProcessStatus, { dot: string; fg: string; bg: string; bd: string }> = {
  running: { dot: '#137a44', fg: 'var(--ok)', bg: 'var(--ok-soft)', bd: 'var(--ok-line)' },
  stopped: { dot: '#9aa6b6', fg: 'var(--ink-subtle)', bg: 'var(--line-soft)', bd: 'var(--line)' },
  crashed: { dot: '#c8323a', fg: 'var(--danger)', bg: 'var(--danger-soft)', bd: 'var(--danger-line)' },
  unknown: { dot: '#b0740f', fg: 'var(--warn)', bg: 'var(--warn-soft)', bd: 'var(--warn-line)' },
}

/** 受管进程：metavr / arm_follow_server 的一键启停（DESIGN 4.2 process.*）。 */
export function VrProcessPanel({ vm }: { vm: VrLinkView }) {
  const { t } = useTranslation('vr')
  const demo = vm.dataSource === 'demo'
  const names = demo
    ? PROCESS_ORDER
    : [...new Set([...PROCESS_ORDER, ...Object.keys(vm.processes)])]

  return (
    <Card className="gap-2.5 rounded-[0.875rem] px-3.5 py-3.5">
      <div className="flex items-center gap-2 text-[0.90625rem] font-semibold text-foreground">
        <Server size="0.9375rem" /> {t('processes.title')}
      </div>

      {demo ? (
        <div className="text-[0.71875rem] text-muted-foreground">{t('processes.demoHint')}</div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {names.map((name) => (
              <ProcessRow
                key={name}
                name={name}
                status={(vm.processes[name] ?? 'unknown') as VrProcessStatus}
                detail={vm.processesDetail[name]}
                onStart={() => vm.startProcess(name)}
                onStop={() => vm.stopProcess(name)}
                labelFor={(status) => t(`processes.status${status[0].toUpperCase()}${status.slice(1)}`)}
                startLabel={t('processes.start')}
                stopLabel={t('processes.stop')}
                pidLabel={t('processes.pid')}
                uptimeLabel={t('processes.uptime')}
                exitLabel={t('processes.exitCode')}
                notConfigured={t('processes.notConfigured')}
                homeWarning={name === 'metavr' ? t('processes.metavrHomeWarning') : ''}
              />
            ))}
          </div>
          <div className="text-[0.65625rem] leading-relaxed text-muted-foreground">{t('processes.hint')}</div>
        </>
      )}
    </Card>
  )
}

function ProcessRow({
  name,
  status,
  detail,
  onStart,
  onStop,
  labelFor,
  startLabel,
  stopLabel,
  pidLabel,
  uptimeLabel,
  exitLabel,
  notConfigured,
  homeWarning,
}: {
  name: string
  status: VrProcessStatus
  detail?: VrProcessDetail
  onStart: () => void
  onStop: () => void
  labelFor: (status: VrProcessStatus) => string
  startLabel: string
  stopLabel: string
  pidLabel: string
  uptimeLabel: string
  exitLabel: string
  notConfigured: string
  homeWarning: string
}) {
  const style = STATUS_STYLE[status]
  const running = status === 'running'
  const unconfigured = status === 'unknown'
  const meta = describe(detail, { pidLabel, uptimeLabel, exitLabel, notConfigured, unconfigured })

  return (
    <div className="flex flex-col gap-1 rounded-[0.625rem] border border-line-soft px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate font-mono text-[0.75rem] font-semibold text-foreground">
          {name}
        </div>
        <Pill dot={style.dot} bg={style.bg} bd={style.bd} fg={style.fg} padding="0.0625rem 0.5rem" fontSize={11}>
          {labelFor(status)}
        </Pill>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={running || unconfigured}
          onClick={onStart}
          className="h-6 rounded-[0.5rem] px-2 text-[0.6875rem]"
        >
          {startLabel}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!running}
          onClick={onStop}
          className="h-6 rounded-[0.5rem] px-2 text-[0.6875rem]"
        >
          {stopLabel}
        </Button>
      </div>
      <div className="truncate font-mono text-[0.625rem] text-ink-muted">{meta}</div>
      {homeWarning && !running && !unconfigured ? (
        <div className="text-[0.65625rem] leading-snug text-warn">{homeWarning}</div>
      ) : null}
    </div>
  )
}

function describe(
  detail: VrProcessDetail | undefined,
  ctx: {
    pidLabel: string
    uptimeLabel: string
    exitLabel: string
    notConfigured: string
    unconfigured: boolean
  },
): string {
  if (ctx.unconfigured) return ctx.notConfigured
  if (!detail) return ''
  const parts: string[] = []
  if (detail.pid) parts.push(`${ctx.pidLabel} ${detail.pid}`)
  if (detail.uptime_s) parts.push(`${ctx.uptimeLabel} ${formatSeconds(detail.uptime_s)}`)
  if (detail.exit_code !== null && detail.exit_code !== undefined && !detail.pid) {
    parts.push(`${ctx.exitLabel} ${detail.exit_code}`)
  }
  // 桥对"异常退出"会把退出码也写进 last_error，别在界面上重复同一件事
  const exitNote =
    detail.exit_code !== null && detail.exit_code !== undefined
      ? `${ctx.exitLabel} ${detail.exit_code}`
      : ''
  if (detail.last_error && detail.last_error !== exitNote) parts.push(detail.last_error)
  return parts.join(' · ')
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${seconds.toFixed(0)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}
