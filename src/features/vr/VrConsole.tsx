import type { CSSProperties } from 'react'
import { ROW_OVERFLOW, SCROLL_COLUMN } from '../../lib/responsive'
import { useVrLink } from './useVrLink'
import { useMotorLoad } from './useMotorLoad'
import { VrLinkPanel } from './VrLinkPanel'
import { VrMotorLoadPanel } from './VrMotorLoadPanel'
import { VrPreviewPanel } from './VrPreviewPanel'
import { VrControlPanel } from './VrControlPanel'

/**
 * 六宫格：上/下 × 左/中/右。
 *
 * 列宽下限 20rem：窗口再窄就横向滚动（ROW_OVERFLOW），而不是把卡片压到看不清 ——
 * 与其它页面的取舍一致，见 `lib/responsive.ts`。行高不设下限：整页高度固定在这里，
 * 内容超出由各格自己滚，页面本身不滚。
 */
const GRID: CSSProperties = {
  flex: 1,
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(20rem, 1fr))',
  gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
  gap: '0.875rem',
  padding: '0.875rem',
  minHeight: '0rem',
  ...ROW_OVERFLOW,
}

/** 一格：一格的卡片变高不会把整页撑开，也不会挤掉旁边那格 */
const CELL: CSSProperties = { ...SCROLL_COLUMN, gap: '0.75rem' }

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
  // 电机负载走的是上位机链路（daemon），与桥无关，见 useMotorLoad
  const motorLoad = useMotorLoad()
  // ⚠ 双臂接线待定：daemon 现在一次只连一台臂，所以先把它摆进左臂那一段。
  // 现场连的是右臂、或以后 daemon 扩成两路，改的就是这两行。
  const leftArm = { live: motorLoad.live, rows: motorLoad.loads, gripper: null }
  const rightArm = { live: false, rows: [], gripper: null }
  // 关节角不是"当前值"的两种情况：桥断开了，或桥连着但 ping 不到跟随服务
  const poseStale = !vm.bridgeOnline || !vm.armConnected

  return (
    <div style={GRID}>
      {/* 左列：一张卡跨两行（电机负载） */}
      <div style={{ ...CELL, gridColumn: '1', gridRow: '1 / span 2' }}>
        <VrMotorLoadPanel left={leftArm} right={rightArm} />
      </div>

      {/* 上排中/右：机械臂预览 · 遥操控制 */}
      <div style={{ ...CELL, gridColumn: '2', gridRow: '1' }}>
        <VrPreviewPanel armSource={vm.bridgeOnline ? vm.armSource : null} stale={poseStale} />
      </div>
      <div style={{ ...CELL, gridColumn: '3', gridRow: '1' }}>
        <VrControlPanel vm={vm} />
      </div>

      {/* 下排中格：VR 链路在预览正下方；右下角先空着 */}
      <div style={{ ...CELL, gridColumn: '2', gridRow: '2' }}>
        <VrLinkPanel vm={vm} />
      </div>
    </div>
  )
}
