import type { CSSProperties } from 'react'
import { ROW_OVERFLOW, SCROLL_COLUMN } from '../../lib/responsive'
import { useVrLink } from './useVrLink'
import { useArmLoads } from './useArmLoads'
import { useArmManifest } from './useArmManifest'
import { VrArmManifestPanel } from './VrArmManifestPanel'
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
 * 唯一的例外是臂映射卡：它写的是**桥那台机器**上的记录（哪条串口接在哪条臂）。
 * 那件事没法"看"出来 —— 配反了不报错，表现只是左手柄的解发给了右边那条臂 ——
 * 所以它必须能改，而且改在**按下开始遥操之前**。
 *
 * 数据源：都走 daemon 转出来的帧（见 `vrDaemonClient`）。桥连不上就显示空态，
 * 不拿本地编造的数据顶上。见 `vrLink.ts` 与 `__fixtures__/bridgeSnapshots.ts`（真实快照固件）。
 *
 * 按臂渲染：桥认到几条臂，负载卡就是几段（`useArmLoads`）。3D 预览**只有一个视图** ——
 * 它画的是一台机器：一条臂时是立式那份模型，两条臂时是支架那份（两条侧装臂同一根立柱，
 * 见 `VrPreviewPanel`）。单臂部署下这跟"只有一条"是一回事。
 */
export function VrConsole() {
  const vm = useVrLink()
  // 电机负载读的是真机状态（上游汇总发的 vr_arm / vr_grip），额定值另从 daemon 读一次，
  // 见 useArmLoads
  const loads = useArmLoads()
  // 臂映射（哪条串口接在哪条臂）：读桥的快照 + 候选口问桥要，改动由桥落盘，见 useArmManifest
  const manifest = useArmManifest()

  return (
    <div style={GRID}>
      {/* 左列：一张卡跨两行（电机负载） */}
      <div style={{ ...CELL, gridColumn: '1', gridRow: '1 / span 2' }}>
        <VrMotorLoadPanel arms={loads.arms} rated={loads.rated} />
      </div>

      {/* 中列：3D 预览吃掉余下的高度，链路卡片按自然高度贴在它下面 */}
      <div style={{ ...CELL, gridColumn: '2', gridRow: '1 / span 2' }}>
        <VrPreviewPanel armSource={vm.bridgeOnline ? vm.armSource : null} arms={vm.arms} />
        <VrLinkPanel vm={vm} />
      </div>

      {/* 右上：遥操控制 */}
      <div style={{ ...CELL, gridColumn: '3', gridRow: '1' }}>
        <VrControlPanel vm={vm} />
      </div>

      {/* 右下：臂映射（哪条串口接在哪条臂）。放在控制卡下面不是随手排的：
          开机顺序就是先确认这两行、再按"开始遥操"——映射错了按下去就是动错臂。 */}
      <div style={{ ...CELL, gridColumn: '3', gridRow: '2' }}>
        <VrArmManifestPanel v={manifest} />
      </div>
    </div>
  )
}
