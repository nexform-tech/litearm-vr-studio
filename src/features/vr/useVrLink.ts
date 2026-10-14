import { useEffect, useSyncExternalStore } from 'react'
import { armClient, useArmConnection } from '../../lib/arm'
import { synthesizeOwnership, type VrOwnership } from './vrOwnership'
import { vrLink } from './vrLink'
import type { VrLinkSnapshot } from './vrTypes'

export type VrLinkView = VrLinkSnapshot & {
  /**
   * 跨两条链路的归属合成结果：VR 侧来自桥，上位机侧来自 studio 自己的
   * litearm-server 连接层。这是本页唯一一个必须由 studio 提供的信息
   * （桥看不见上位机链路），见 `vrOwnership.ts`。
   */
  ownership: VrOwnership
  /** 桥地址（用于在界面上显示/排障） */
  bridgeEndpoint: string
  /** 配过桥地址没有；没配过时页面提示去填，而不是显示"连不上" */
  bridgeConfigured: boolean
  startFollow: () => void
  stopFollow: () => void
  emergencyStop: () => void
  /** 修改桥地址（存本地并重连） */
  setBridgeEndpoint: (endpoint: string) => void
}

/**
 * VR 链路数据 + 开关动作。整页只依赖这个 hook；
 * 换成真实数据源时只改 `vrLink.ts`，页面一行不用动。
 */
export function useVrLink(): VrLinkView {
  const snapshot = useSyncExternalStore(vrLink.subscribe, () => vrLink.snapshot)
  // 上位机链路：studio 自己连着机械臂，桥看不到这一半。
  // 地址取 daemon 报的串口（`conn.port`）——本仓库的上位机链路是
  // studio → 本机 daemon → 串口，没有 litearm-server 那样的 host:port 端点，
  // 所以这里沿用 TopBar 显示连接用的同一个字段。
  const { status: armStatus, motionBusy, conn: armConn } = useArmConnection()
  // 只取状态机名字（字符串）而不是整份 RobotState：快照是引用比较，
  // 这样机械臂静止时（50Hz 广播内容不变）不会带着整页重渲染。
  const robotStateName = useSyncExternalStore(armClient.subscribeState, () => armClient.state?.state ?? null)

  useEffect(() => {
    vrLink.start()
    return () => {
      vrLink.stop()
    }
  }, [])

  const ownership = synthesizeOwnership({
    bridgeOwner: snapshot.owner,
    bridgeFollowing: snapshot.following,
    bridgeArmState: snapshot.armState,
    console: {
      connected: armStatus === 'connected',
      endpoint: armConn?.port ?? '',
      motionBusy,
      robotState: robotStateName,
    },
  })

  return {
    ...snapshot,
    ownership,
    bridgeEndpoint: vrLink.bridgeEndpoint,
    bridgeConfigured: vrLink.bridgeConfigured,
    startFollow: vrLink.startFollow,
    stopFollow: vrLink.stopFollow,
    emergencyStop: vrLink.emergencyStop,
    setBridgeEndpoint: vrLink.setBridgeEndpoint,
  }
}
