import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { armClient, useArmConnection } from '@/lib/arm'
import { vrBridge } from '@/features/vr/vrBridgeClient'
import { consoleActivityLabel, consoleActivityOf } from '@/features/vr/vrOwnership'

/**
 * VR 页的顶栏：**只报两条链路的通断，不给任何控制**。
 *
 * 为什么与控制页那条分开：控制页那条管的是"本控制台驱动哪台设备"（选串口、连接、断开），
 * 而 VR 遥操根本不走那条链路 —— 那几个按钮摆在这里既按不动，也按不出对的结果。
 * 反过来，这一页最需要一眼看到的两件事，控制页那条顶栏又都不说：
 *
 *   * **桥**：这一页唯一的数据源。地址是现场相关的（桥跑在机械臂那台机器上），
 *     没配过就直说"未设置"，不显示"连不上"；
 *   * **上位机链路**：电机负载卡的数就是从这条来的，而且 studio 与 VR 是不是**同时在控**
 *     也取决于它（见 `vrOwnership.ts` 的互斥判定）。
 *
 * 一行放不下时各自截断，不换行 —— 顶栏高度是固定的（`h-14`），页面按它算剩余空间。
 */

/**
 * 订阅用的快照键。
 *
 * ⚠ 它必须是**字符串**：桥每收到一帧就 notify 一次（10Hz），`useSyncExternalStore`
 * 拿新对象跟旧对象比永远不相等，这一条就会在 10Hz 上重渲染整条顶栏。字符串只在真正
 * 相关的四个值变化时才变，取数照旧直接问 `vrBridge`（都是便宜的 getter）。
 */
function bridgeStateKey(): string {
  return [
    vrBridge.online ? '1' : '0',
    vrBridge.configured ? '1' : '0',
    vrBridge.endpoint,
    vrBridge.snapshot?.bridge?.version ?? '',
  ].join('\u0000')
}

export function VrTopBar() {
  const { t } = useTranslation(['common', 'nav', 'vr'])

  useSyncExternalStore(vrBridge.subscribe, bridgeStateKey)
  const bridgeOnline = vrBridge.online
  const bridgeConfigured = vrBridge.configured
  const bridgeEndpoint = vrBridge.endpoint
  const bridgeVersion = vrBridge.snapshot?.bridge?.version ?? ''

  // 上位机链路：与 VR 页自己读的是同一批字段（`useVrLink.ts` 的口径），这样顶栏说的
  // "上位机在不在动"和页面里那条互斥告警永远是同一件事。
  const { status, conn, motionBusy } = useArmConnection()
  const robotState = useSyncExternalStore(
    armClient.subscribeState,
    () => armClient.state?.state ?? null,
  )
  const consoleConnected = status === 'connected'
  const activity = consoleActivityOf({
    connected: consoleConnected,
    endpoint: conn?.port ?? '',
    motionBusy,
    robotState,
  })

  // 没配过地址时说的是"未设置"，不是"未连接"：后者会让操作员去查网络，
  // 而实际要做的只是把地址填上。
  const bridgeState = bridgeOnline
    ? t('common:connected')
    : bridgeConfigured
      ? t('common:disconnected')
      : t('vr:topbar.bridgeUnset')

  return (
    <div className="flex h-14 flex-none basis-14 items-center justify-between border-b bg-card px-[1.125rem]">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <div className="flex-none text-base font-bold text-foreground">{t('nav:vrTitle')}</div>

        {/* 桥 */}
        <div
          data-testid="vr-topbar-bridge"
          className="flex min-w-0 items-center gap-2"
          title={bridgeConfigured ? bridgeEndpoint : t('vr:topbar.bridgeHint')}
        >
          <div
            aria-hidden="true"
            className={cn(
              'size-[0.4375rem] flex-none rounded-full',
              bridgeOnline ? 'bg-success' : bridgeConfigured ? 'bg-warn' : 'bg-muted-foreground',
            )}
          />
          <span className="flex-none text-xs font-medium text-muted-foreground">
            {t('vr:topbar.bridgeLabel')}
          </span>
          <span className="flex-none text-xs font-semibold text-foreground">{bridgeState}</span>
          {bridgeConfigured ? (
            <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
              {bridgeEndpoint}
            </span>
          ) : null}
          {bridgeOnline && bridgeVersion ? (
            <span className="flex-none font-mono text-[0.6875rem] text-muted-foreground">
              v{bridgeVersion}
            </span>
          ) : null}
        </div>

        {/* 上位机链路（studio → daemon → 串口） */}
        <div data-testid="vr-topbar-console" className="flex min-w-0 items-center gap-2">
          <div
            aria-hidden="true"
            className={cn(
              'size-[0.4375rem] flex-none rounded-full',
              consoleConnected ? 'bg-success' : 'bg-muted-foreground',
            )}
          />
          <span className="flex-none text-xs font-medium text-muted-foreground">
            {t('vr:topbar.consoleLabel')}
          </span>
          <span className="flex-none text-xs font-semibold text-foreground">
            {consoleConnected ? t('common:connected') : t('common:disconnected')}
          </span>
          {consoleConnected && conn?.port ? (
            <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
              {conn.port}
            </span>
          ) : null}
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
    </div>
  )
}
