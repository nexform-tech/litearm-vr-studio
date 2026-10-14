import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui/card'
import { ROW_OVERFLOW, SCROLL_COLUMN, SIDE_COL_TASK, SIDE_COL_WIDE } from '../../lib/responsive'
import { useVrLink } from './useVrLink'
import { VrLinkPanel } from './VrLinkPanel'
import { VrJointsPanel } from './VrJointsPanel'
import { VrEventsPanel } from './VrEventsPanel'
import { VrPreviewPanel } from './VrPreviewPanel'
import { VrControlPanel } from './VrControlPanel'
import { VrProcessPanel } from './VrProcessPanel'

/**
 * VR 遥操控制台。
 *
 * 定位：只做「看状态」和「按开关」。手柄数据 90Hz 直接进 metavr 做逆解并驱动
 * 机械臂，控制回路不经过上位机（多一跳就多一份延迟，也把上位机的可用性绑到机械臂上）。
 *
 * 数据源：桥在线时用真实链路（litearm-vr-bridge 的 /ws/status），桥不在时退回本地演示。
 * 见 `vrLink.ts` 与 `__fixtures__/bridgeSnapshots.ts`（真实快照固件）。
 */
export function VrConsole() {
  const vm = useVrLink()

  return (
    <div style={{ flex: 1, display: 'flex', gap: '0.875rem', padding: '0.875rem', minHeight: '0rem', ...ROW_OVERFLOW }}>
      {/* LEFT: 链路 + 数据 */}
      <div style={{ ...SCROLL_COLUMN, ...SIDE_COL_WIDE, gap: '0.75rem' }}>
        <VrLinkPanel vm={vm} />
        <VrJointsPanel q={vm.q} stale={vm.dataSource === 'bridge' && !vm.armConnected} />
        <VrEventsPanel vm={vm} />
      </div>

      {/* MIDDLE: 3D 预览 */}
      <div style={{ ...SCROLL_COLUMN, flex: '1 1 30rem', minWidth: '26.25rem', gap: '0.75rem' }}>
        <VrPreviewPanel armSource={vm.armSource} />
      </div>

      {/* RIGHT: 控制 + 说明 */}
      <div style={{ ...SCROLL_COLUMN, ...SIDE_COL_TASK, gap: '0.75rem' }}>
        <VrControlPanel vm={vm} />
        <VrProcessPanel vm={vm} />
        <VrAboutCard vm={vm} />
      </div>
    </div>
  )
}

function VrAboutCard({ vm }: { vm: ReturnType<typeof useVrLink> }) {
  const { t } = useTranslation('vr')

  return (
    <Card className="gap-2.5 rounded-[0.875rem] px-3.5 py-3.5">
      <div className="text-[0.90625rem] font-semibold text-foreground">{t('about.title')}</div>
      <div className="flex flex-col gap-2 text-[0.71875rem] leading-relaxed text-muted-foreground">
        <div>{t('about.view')}</div>
        <div>{t('about.switch')}</div>
        <div>{t('about.loop')}</div>
        <div>{t('about.owner')}</div>
      </div>
      <div className="rounded-[0.625rem] border border-line-soft bg-muted/40 px-2.5 py-2 text-[0.71875rem] text-ink-soft">
        {vm.bridgeOnline ? t('about.noteBridge') : t('about.noteDemo')}
      </div>
    </Card>
  )
}
