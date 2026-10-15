import { useLocation } from 'react-router-dom'
import { useState } from 'react'
import { ControlTopBar } from './ControlTopBar'
import { VrTopBar } from './VrTopBar'

/**
 * 顶栏外壳：按路由选一副内容。
 *
 * 它挂在 `AppShell` 上、所有页面共用一条（`layout/AppShell.tsx`），但**内容因页而异**：
 * 控制页那条要能选串口、连/断机械臂，而 VR 页根本不走那条链路，摆着只会误导。
 * 主题与语言不在这里 —— 那是左侧导航栏的事（`RailNav.tsx`）。
 *
 * ⚠ 判据必须是 `=== '/vr'`，不能写成"不是 /control"：`titleMap` 没有的路径要落到
 * 控制页那条（那是本仓库一贯的兜底），写成反判会让未知路由显示成 VR 页的顶栏。
 */
export function TopBar() {
  const { pathname } = useLocation()
  /**
   * 「这次点连接要连哪个口」还没提交的选择。
   *
   * ⚠ 它必须活在外壳里：从前 `TopBar` 从不卸载，这个值就跟着活到整页刷新；现在切路由
   * 会换掉下面的内容，状态留在控制页那支就会**丢**（操作员选了口、去 VR 页转一圈回来，
   * 又变回"自动发现"）。设备拔了之后仍能重试同一个口，是这条状态当初存在的理由。
   */
  const [pendingPort, setPendingPort] = useState<string | null>(null)

  if (pathname === '/vr') return <VrTopBar />
  return (
    <ControlTopBar pathname={pathname} pendingPort={pendingPort} onPickPort={setPendingPort} />
  )
}
