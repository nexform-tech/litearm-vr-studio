import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { VrLinkView } from './useVrLink'
import { consoleActivityLabel } from './vrOwnership'

/**
 * 上位机在 VR 链路里只按开关：开始 / 停止 / 急停。控制回路在 metavr，不在这里。
 *
 * 注意：这三个按钮**真的会作用到机械臂**（急停会向跟随服务下发 stop），所以桥没连上
 * 时一律禁用 —— 按钮亮着却发不出去，比直接灰掉更危险。
 *
 * 控制归属不照抄桥的 `owner`：桥只看得见 VR 一侧，上位机这一侧（studio →
 * litearm-server :7449）只有本页知道。合成逻辑见 `vrOwnership.ts`。
 */
export function VrControlPanel({ vm }: { vm: VrLinkView }) {
  const { t } = useTranslation('vr')
  const offline = !vm.headsetOnline
  // 桥没连上就什么都发不出去：三个按钮一起禁用
  const unavailable = !vm.bridgeOnline
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

      {/* 三颗按钮同高、位置常驻，不随状态挪动：急停在最上面占满一行，
          开始 / 停止并列在它下面 */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={unavailable || offline}
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
        <div className="flex gap-2">
          <Button
            type="button"
            disabled={unavailable || offline || vm.following || blocked}
            onClick={vm.startFollow}
            title={blocked ? t('control.consoleBusyHint') : undefined}
            className="h-11 min-w-0 flex-1 rounded-[0.625rem] text-[0.84375rem] font-semibold"
          >
            {t('control.start')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={unavailable || !vm.following}
            onClick={vm.stopFollow}
            className="h-11 min-w-0 flex-1 rounded-[0.625rem] text-[0.84375rem] font-semibold"
          >
            {t('control.stop')}
          </Button>
        </div>
      </div>

      {vm.rearmRequired || vm.fallbackActive ? (
        <div className="rounded-[0.625rem] border border-warn-line bg-warn-soft px-2.5 py-2 text-[0.71875rem] text-warn">
          {t('control.rearmHint')}
        </div>
      ) : null}
    </Card>
  )
}

/** 上位机侧"在动"的文案：与顶栏共用一份，见 `vrOwnership.consoleActivityLabel` */
const activityLabel = consoleActivityLabel
