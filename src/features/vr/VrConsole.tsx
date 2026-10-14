import { ROW_OVERFLOW, SCROLL_COLUMN, SIDE_COL_TASK, SIDE_COL_WIDE } from '../../lib/responsive'
import { useVrLink } from './useVrLink'
import { VrLinkPanel } from './VrLinkPanel'
import { VrJointsPanel } from './VrJointsPanel'
import { VrPreviewPanel } from './VrPreviewPanel'
import { VrControlPanel } from './VrControlPanel'

/**
 * VR 遥操控制台。
 *
 * 定位：只做「看状态」和「按开关」。手柄数据 90Hz 直接进 metavr 做逆解并驱动
 * 机械臂，控制回路不经过上位机（多一跳就多一份延迟，也把上位机的可用性绑到机械臂上）。
 *
 * 数据源：只有一个 —— litearm-vr-bridge 的 `/ws/status`。桥连不上就显示空态，
 * 不拿本地编造的数据顶上。见 `vrLink.ts` 与 `__fixtures__/bridgeSnapshots.ts`（真实快照固件）。
 */
export function VrConsole() {
  const vm = useVrLink()
  // 关节角不是"当前值"的两种情况：桥断开了，或桥连着但 ping 不到跟随服务
  const poseStale = !vm.bridgeOnline || !vm.armConnected

  return (
    <div style={{ flex: 1, display: 'flex', gap: '0.875rem', padding: '0.875rem', minHeight: '0rem', ...ROW_OVERFLOW }}>
      {/* LEFT: 链路 + 数据 */}
      <div style={{ ...SCROLL_COLUMN, ...SIDE_COL_WIDE, gap: '0.75rem' }}>
        <VrLinkPanel vm={vm} />
        <VrJointsPanel q={vm.q} stale={poseStale} />
      </div>

      {/* MIDDLE: 3D 预览 */}
      <div style={{ ...SCROLL_COLUMN, flex: '1 1 30rem', minWidth: '26.25rem', gap: '0.75rem' }}>
        <VrPreviewPanel armSource={vm.bridgeOnline ? vm.armSource : null} stale={poseStale} />
      </div>

      {/* RIGHT: 控制 */}
      <div style={{ ...SCROLL_COLUMN, ...SIDE_COL_TASK, gap: '0.75rem' }}>
        <VrControlPanel vm={vm} />
      </div>
    </div>
  )
}
