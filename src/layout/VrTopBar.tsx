import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { armClient, useArmConnection } from '@/lib/arm'
import { consoleActivityLabel, consoleActivityOf } from '@/features/vr/vrOwnership'
import { VrConfigButton } from '@/features/vr/VrConfigDialog'

/**
 * VR 页的顶栏。
 *
 * 它只放**页面别处说不了的那一件事**，不做任何"总览"：
 *
 *   * **上位机正在驱动机械臂**：这是 VR 与上位机互斥判定的输入，也是操作员在按下
 *     "开始遥操"之前必须知道的事。
 *   * **桥的配置面**（右上角那颗按钮，见 `VrConfigDialog`）：真机/仿真、装法、
 *     控制律这些改一次就不用再看的，收进弹窗，不占下面那六格。
 *
 * ⚠ 桥地址**不再是输入项**（2026-10-15）：页面不再自己连桥 —— 桥说的是 zenoh，
 * 浏览器说不了，替它说的是 daemon（`vrDaemonClient`），而 daemon 与页面同源、
 * 端点属于那台机器的配置（同机默认 `tcp/127.0.0.1:7447`）。"连上了没有"由链路卡
 * 按事实说，不需要操作员填一个字。
 *
 * ⚠ 桥的在线状态与版本**故意不在这里**：链路卡的数据源那一行与它自己那颗徽标已经把
 * 这两样说全了，顶栏再说一遍就成了"同一句话在一张页面里说两遍"——那正是这一页
 * 一直避免的（见 `VrLinkPanel` 里关于"未连接"只由流程条说的那段）。
 * 上位机连没连同理：电机负载卡与控制卡各自会说。
 *
 * 与控制页那条顶栏（选串口、连/断设备）分开的理由，见 `TopBar.tsx` 的分派。
 */
export function VrTopBar() {
  const { t } = useTranslation(['common', 'nav', 'vr'])

  // 上位机链路：与 VR 页自己读的是同一批字段（`useVrLink.ts` 的口径），
  // 这样顶栏说的"在动"和页面里那条互斥告警永远是同一件事。
  const { status, conn, motionBusy } = useArmConnection()
  const robotState = useSyncExternalStore(
    armClient.subscribeState,
    () => armClient.state?.state ?? null,
  )
  const activity = consoleActivityOf({
    connected: status === 'connected',
    endpoint: conn?.port ?? '',
    motionBusy,
    robotState,
  })

  return (
    <div className="flex h-14 flex-none basis-14 items-center justify-between border-b bg-card px-[1.125rem]">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <div className="flex-none text-base font-bold text-foreground">{t('nav:vrTitle')}</div>

        {/* 只在真在动的时候出现：空闲是常态，写成常驻标签只会让人不再看它 */}
        {activity ? (
          <span
            data-testid="vr-topbar-console-activity"
            className="flex-none rounded-full bg-warn-soft px-2 py-0.5 text-[0.6875rem] font-medium text-warn"
            title={consoleActivityLabel(t, activity)}
          >
            {t('vr:topbar.consoleBusy')}
          </span>
        ) : null}
      </div>

      {/* 右上角：桥的配置面收成一颗按钮（点开是表单）。这一页的六格留给**遥操时要
          一直盯着**的东西，配置是开机改一次、之后不看的 —— 但它又必须在这一页上，
          改的是同一台桥。 */}
      <VrConfigButton />
    </div>
  )
}
