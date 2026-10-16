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
 * 三列，每列各自一叠：
 * 左列电机负载（满高）、中列 3D 预览（满高）、右列三张（遥操控制 / 臂映射 / VR 链路）。
 *
 * 左右两列各让一张卡独占，是因为它们是这一页"一直盯着"的两样 —— 负载要看数字、
 * 3D 要看姿态，按内容高度排都会被压扁。右列三张从上到下：起停（遥操控制）、
 * 状态（VR 链路）、接线（臂映射）。
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
 * 唯一的例外是臂映射卡：它写的是**桥那台机器**上的记录（哪条串口接在哪条臂、夹爪在哪个
 * CAN 口）。那件事没法"看"出来 —— 配反了不报错，表现只是左手柄的解发给了右边那条臂 ——
 * 所以它必须能改，而且改在**按下开始遥操之前**：它是这一页的第一步，所以摆在左上角。
 *
 * 数据源：都走 daemon 转出来的帧（见 `vrDaemonClient`）。桥连不上就显示空态，
 * 不拿本地编造的数据顶上。见 `vrLink.ts` 与 `__fixtures__/bridgeSnapshots.ts`（真实快照固件）。
 *
 * 负载卡**固定两段**：左臂在上、右臂在下（`useArmLoads` 排槽）—— 没认到臂、没读数的那
 * 一段照摆空骨架，位置与"这一页盯的是哪两条臂"不随桥在不在变。3D 预览**只有一个视图** ——
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
      {/* 左列：电机负载**独占整列**。它是这一页要一直盯着的那张表，之前和臂映射挤在
          一格、按内容高度排，被压得很扁；给它满高，读数才看得清。 */}
      <div style={{ ...CELL, gridColumn: '1', gridRow: '1 / span 2' }}>
        <VrMotorLoadPanel arms={loads.arms} rated={loads.rated} />
      </div>

      {/* 中列：3D 预览**独占整列**。这一页只有它一个地方"看得见机器"，
          挤它等于把最该看清的东西压小。 */}
      <div style={{ ...CELL, gridColumn: '2', gridRow: '1 / span 2' }}>
        <VrPreviewPanel armSource={vm.bridgeOnline ? vm.armSource : null} arms={vm.arms} />
      </div>

      {/* 右列：从上到下就是操作的顺序 —— 先起链路（遥操控制）、再对着实物确认接线
          （臂映射）、然后一直盯着它跑得对不对（VR 链路）。 */}
      <div style={{ ...CELL, gridColumn: '3', gridRow: '1 / span 2' }}>
        <VrControlPanel vm={vm} />
        <VrLinkPanel vm={vm} />
        <VrArmManifestPanel v={manifest} />
      </div>
    </div>
  )
}
