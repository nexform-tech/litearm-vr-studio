import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { armClient, useArmConnection } from '@/lib/arm'
import { setBridgeEndpoint, vrBridge } from '@/features/vr/vrBridgeClient'
import { consoleActivityLabel, consoleActivityOf } from '@/features/vr/vrOwnership'

/**
 * VR 页的顶栏。
 *
 * 它只放**页面别处说不了的两件事**，不做任何"总览"：
 *
 *   * **桥地址**：现场相关的输入项（桥跑在机械臂那台机器上），页面上只此一处；
 *   * **上位机正在驱动机械臂**：这是 VR 与上位机互斥判定的输入，也是操作员在按下
 *     "开始遥操"之前必须知道的事。
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

  /**
   * 桥地址是**可填的**。
   *
   * 装机时若忘了注入构建期的 `VITE_VR_BRIDGE_ENDPOINT`，操作员原先只能去改
   * localStorage —— 页面上连个入口都没有（`a651cb5` 删输入框时自己把这条标成了
   * Breaking）。填在这里，存本机，立刻重连。
   */
  const [draft, setDraft] = useState(() => vrBridge.endpoint)

  const applyEndpoint = () => {
    setBridgeEndpoint(draft)
    // 取回客户端归一化后的值（去空白、去尾斜杠），让输入框显示的就是真正存下的那个
    setDraft(vrBridge.endpoint)
  }

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

        <div className="flex min-w-0 items-center gap-2" title={t('vr:topbar.bridgeHint')}>
          <span className="flex-none text-xs font-medium text-muted-foreground">
            {t('vr:topbar.bridgeLabel')}
          </span>
          {/* ⚠ 宽度定在外层：`Input` 自带 `w-full`，同一个工具类再写一遍谁赢由样式表顺序
              决定，不由类名顺序决定 —— 直接把宽度写在它身上会被 `w-full` 压成父容器的宽。 */}
          <div className="w-[20rem] flex-none">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyEndpoint()
              }}
              placeholder={t('vr:topbar.addressPlaceholder')}
              spellCheck={false}
              aria-label={t('vr:topbar.addressLabel')}
              className="h-7 font-mono text-[0.6875rem]"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={applyEndpoint}
            className="h-7 flex-none rounded-[0.5rem] px-2 text-[0.75rem]"
          >
            {t('vr:topbar.addressApply')}
          </Button>
        </div>

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
    </div>
  )
}
