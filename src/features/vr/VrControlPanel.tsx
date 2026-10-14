import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { VrLinkView } from './useVrLink'
import type { VrConsoleActivity } from './vrOwnership'

/**
 * 上位机在 VR 链路里只按开关：开始 / 停止 / 急停。控制回路在 metavr，不在这里。
 *
 * 注意：桥在线时这三个按钮**真的会作用到机械臂**（急停会向跟随服务下发 stop），
 * 所以文案不能再说"演示"。桥离线时才退回本地演示语义。
 *
 * 控制归属不照抄桥的 `owner`：桥只看得见 VR 一侧，上位机这一侧（studio →
 * litearm-server :7449）只有本页知道。合成逻辑见 `vrOwnership.ts`。
 */
export function VrControlPanel({ vm }: { vm: VrLinkView }) {
  const { t } = useTranslation('vr')
  const offline = !vm.headsetOnline
  const demo = vm.dataSource === 'demo'
  const { ownership } = vm
  const consoleActivity = ownership.console.activity
  // 两条链路互斥：只要上位机侧正在驱动机械臂，就不能从这一页再开一路控制
  const blocked = ownership.conflict || ownership.console.inControl
  const ownerLabel = t(`control.owner_${ownership.owner}`)
  const ownerColor =
    ownership.owner === 'vr'
      ? 'var(--ok)'
      : ownership.owner === 'console'
        ? 'var(--warn)'
        : ownership.owner === 'conflict'
          ? 'var(--danger)'
          : 'var(--ink-subtle)'
  const consoleColor = !ownership.console.connected
    ? 'var(--ink-subtle)'
    : ownership.conflict
      ? 'var(--danger)'
      : ownership.console.inControl
        ? 'var(--warn)'
        : 'var(--ok)'

  return (
    <Card className="gap-3 rounded-[0.875rem] px-3.5 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[0.90625rem] font-semibold text-foreground">{t('control.title')}</div>
        <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          {t('control.ownerLabel')}
          <span className="font-semibold" style={{ color: ownerColor }}>
            {ownerLabel}
          </span>
        </div>
      </div>

      {/* 两条链路同时在控：互斥被打破，必须先停掉一侧 */}
      {ownership.conflict ? (
        <div className="flex items-start gap-2 rounded-[0.625rem] border border-danger-line bg-danger-soft px-2.5 py-2">
          <TriangleAlert size="0.9375rem" className="mt-[0.0625rem] flex-none text-danger" />
          <div className="min-w-0">
            <div className="text-[0.78125rem] font-semibold text-danger">{t('control.conflictTitle')}</div>
            <div className="text-[0.6875rem] leading-relaxed text-danger/85">{t('control.conflictBody')}</div>
          </div>
        </div>
      ) : ownership.console.inControl ? (
        <div className="flex items-start gap-2 rounded-[0.625rem] border border-warn-line bg-warn-soft px-2.5 py-2">
          <TriangleAlert size="0.9375rem" className="mt-[0.0625rem] flex-none text-warn" />
          <div className="min-w-0">
            <div className="text-[0.78125rem] font-semibold text-warn">{t('control.consoleBusyTitle')}</div>
            <div className="text-[0.6875rem] leading-relaxed text-warn/85">
              {t('control.consoleBusyBody', { activity: activityLabel(t, consoleActivity) })}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          disabled={offline || vm.following || blocked}
          onClick={vm.startFollow}
          title={blocked ? t('control.consoleBusyHint') : undefined}
          className="h-9 w-full rounded-[0.625rem] text-[0.84375rem] font-semibold"
        >
          {t('control.start')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!vm.following}
          onClick={vm.stopFollow}
          className="h-9 w-full rounded-[0.625rem] text-[0.84375rem] font-semibold"
        >
          {t('control.stop')}
        </Button>
        <button
          type="button"
          disabled={offline}
          title={t('control.estopHint')}
          onClick={vm.emergencyStop}
          className="h-11 w-full rounded-[0.625rem] text-[0.9375rem] font-extrabold tracking-[0.125rem] text-white disabled:cursor-not-allowed disabled:opacity-45"
          style={{
            background: 'linear-gradient(180deg,#f0424a,#d5262e)',
            boxShadow: '0 0.125rem 0.375rem rgba(213,38,46,.3)',
          }}
        >
          {t('control.estop')}
        </button>
      </div>

      {vm.rearmRequired || vm.fallbackActive ? (
        <div className="rounded-[0.625rem] border border-warn-line bg-warn-soft px-2.5 py-2 text-[0.71875rem] text-warn">
          {t('control.rearmHint')}
        </div>
      ) : null}

      {/* 上位机链路（studio → litearm-server）：桥看不到这一半，只有这里能显示 */}
      <div className="rounded-[0.625rem] border border-line-soft bg-muted/40 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <div
              className="size-[0.4375rem] flex-none rounded-full"
              style={{ background: ownership.console.connected ? consoleColor : 'var(--line)' }}
            />
            <div className="truncate text-[0.75rem] font-semibold text-foreground">{t('control.consoleTitle')}</div>
            <div className="flex-none text-[0.6875rem]" style={{ color: consoleColor }}>
              {ownership.console.inControl ? t('control.consoleInControl') : t('control.consoleIdle')}
            </div>
          </div>
          <div className="flex-none truncate font-mono text-[0.625rem] text-ink-muted">
            {ownership.console.endpoint || '—'}
          </div>
        </div>
        <div className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
          {ownership.console.inControl
            ? t('control.consoleBusyHint')
            : ownership.console.connected
              ? t('control.consoleIdleHint')
              : t('control.consoleOfflineHint')}
        </div>
      </div>

      <div className="rounded-[0.625rem] border border-line-soft bg-muted/40 px-2.5 py-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
        {offline ? t('control.offlineHint') : demo ? t('control.demoHint') : t('control.bridgeHint')}
      </div>
    </Card>
  )
}

/** 上位机侧"在动"的文案（用于告警条） */
function activityLabel(t: (key: string) => string, activity: VrConsoleActivity | null): string {
  switch (activity) {
    case 'motion':
      return t('control.consoleActivityMotion')
    case 'following':
      return t('control.consoleActivityFollowing')
    case 'zero_gravity':
      return t('control.consoleActivityZeroGravity')
    case 'impedance':
      return t('control.consoleActivityImpedance')
    case 'stopping':
      return t('control.consoleActivityStopping')
    default:
      return t('control.consoleIdle')
  }
}
