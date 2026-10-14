import { useTranslation } from 'react-i18next'
import { Bell, X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { VrLinkView } from './useVrLink'
import type { VrBridgeEvent, VrBridgeEventLevel } from './vrTypes'

const LEVEL_COLOR: Record<VrBridgeEventLevel, string> = {
  danger: '#c8323a',
  warn: '#b0740f',
  info: '#5c6b7f',
  debug: '#9aa6b6',
}

/**
 * 桥推来的事件与告警（DESIGN 4.1 的 `events`）。
 *
 * 桥对事件按 TTL 重复推送（没有消费确认通道），所以这里给每条事件一个"忽略"，
 * 以及一个"清空"——清空会顺带让桥也清（`event.clear`）。
 */
export function VrEventsPanel({ vm }: { vm: VrLinkView }) {
  const { t } = useTranslation('vr')
  const events = vm.events
  // 桥断开后事件列表里剩的是"桥离开前最后收到的那批"，说清楚免得当成实时告警
  const staleEvents = !vm.bridgeOnline && events.length > 0

  return (
    <Card className="gap-2.5 rounded-[0.875rem] px-3.5 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[0.90625rem] font-semibold text-foreground">
          <Bell size="0.9375rem" /> {t('events.title')}
          {events.length > 0 ? (
            <span className="font-mono text-[0.6875rem] text-muted-foreground">{events.length}</span>
          ) : null}
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={events.length === 0}
          onClick={vm.clearEvents}
          className="h-6 rounded-[0.5rem] px-2 text-[0.6875rem] text-ink-muted"
        >
          {t('events.clear')}
        </Button>
      </div>

      {staleEvents ? (
        <div className="rounded-[0.5rem] border border-line-soft bg-muted/40 px-2 py-1.5 text-[0.6875rem] text-muted-foreground">
          {t('events.staleNote')}
        </div>
      ) : null}

      {events.length === 0 ? (
        <div className="px-1 py-2 text-[0.71875rem] text-muted-foreground">{t('events.empty')}</div>
      ) : (
        <div className="flex max-h-[15rem] flex-col gap-1 overflow-y-auto">
          {events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              levelLabel={t(`events.level${levelKey(event.level)}`, { defaultValue: '' })}
              dismissLabel={t('events.dismiss')}
              onDismiss={() => vm.dismissEvent(event.id)}
            />
          ))}
        </div>
      )}
    </Card>
  )
}

function levelKey(level: VrBridgeEventLevel): string {
  if (level === 'danger') return 'Danger'
  if (level === 'warn') return 'Warn'
  return 'Info'
}

function EventRow({
  event,
  levelLabel,
  dismissLabel,
  onDismiss,
}: {
  event: VrBridgeEvent
  levelLabel: string
  dismissLabel: string
  onDismiss: () => void
}) {
  const color = LEVEL_COLOR[event.level]
  return (
    <div className="group flex items-start gap-2 rounded-[0.5rem] px-2 py-1.5 odd:bg-muted/40">
      <div
        className="mt-[0.3125rem] size-[0.375rem] flex-none rounded-full"
        style={{ background: color }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[0.625rem] font-semibold" style={{ color }}>
            {event.code}
          </span>
          <span className="text-[0.59375rem] uppercase tracking-wide" style={{ color }}>
            {levelLabel}
          </span>
          <span className="ml-auto flex-none font-mono text-[0.59375rem] text-ink-faint">
            {formatClock(event.ts)}
          </span>
        </div>
        <div className="text-[0.71875rem] leading-snug text-ink-soft">{event.message}</div>
      </div>
      <button
        type="button"
        title={dismissLabel}
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="mt-[0.125rem] flex-none rounded-[0.375rem] p-0.5 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X size="0.8125rem" />
      </button>
    </div>
  )
}

function formatClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}
