import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Box } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { RobotViewport, type RobotViewportHandle } from '@/components/RobotViewport'
import { cn } from '@/lib/utils'
import { vrLink, type VrArmView } from './vrLink'
import type { VrArmSource } from './vrTypes'

/**
 * 机械臂 3D 预览：**每条臂一格**，姿态走 16ms 通道直接推给视口，不经过 React 渲染循环。
 *
 * 关节角取自真机状态（`vr_arm` 的 `q`，见 `vrLink` 的逐臂视图）：双臂时两格各画各的臂，
 * 一格对应一条臂由格子左下角的臂身份标出来。桥掉线后格子停在最后一次真值上（不是零位），
 * 卡片右上角的数据源会说"未知"。
 *
 * ⚠ 已知偏差（本次从 VR 分支搬页面时留下的）：原实现渲染的是 metavr 那份 URDF
 * （`VR_ROBOT_MODEL`，见 litearm-vr-bridge docs/DESIGN.md 8.3），因为桥推来的
 * `arm.q` 是 metavr 的逆解结果。但本仓库的 `RobotViewport` 没有 `model` prop，
 * 内置的是 studio 自己那份 URDF，两份模型关节 origin/轴向/限位都不同（实测同一
 * 组 q 末端位姿差 2~4cm、姿态差约 90°），所以这里的画面与 metavr 的认知对不上，
 * 看起来会"画歪"。
 *
 * 要对上，需要给 `RobotViewport` 加 `model` prop 并把 metavr 的 URDF 放进
 * `public/description/vr/`（VR 页只做展示时不影响其它功能）。
 */
const RENDERED_MODEL_LABEL = 'studio'

/**
 * `armSource` 为 null = 桥没连上，这一侧是仿真还是真机**无从判断**，别猜。
 */
export function VrPreviewPanel({
  armSource,
  arms,
}: {
  armSource: VrArmSource | null
  /** 逐臂视图（`useVrLink().arms`）：一条臂一格 */
  arms: VrArmView[]
}) {
  const { t } = useTranslation('vr')
  const [showAxes, setShowAxes] = useState(true)
  const views = useRef(new Map<string, RobotViewportHandle>())

  const register = useCallback((key: string, handle: RobotViewportHandle | null) => {
    if (handle) views.current.set(key, handle)
    else views.current.delete(key)
  }, [])

  // 聚焦/俯视是对着**所有**格子做的：三颗按钮各管一条臂会变成 3×N 颗
  const forEachView = (fn: (view: RobotViewportHandle) => void) => {
    for (const view of views.current.values()) fn(view)
  }

  // ⚠ "不知道"是**常态**，不是异常：仿真还是真机是桥那一侧的事，而桥现在不照下游 ——
  //   这一栏只有在跟随服务正连着（它报的就是真机）时才敢写"真机姿态"。以前它默认写
  //   "仿真姿态"，那是替一条已经不存在的通道说话。（`sim` 那一档留着：上游哪天重新报，
  //   这里接上就行。）
  const sourceLabel =
    armSource === 'real'
      ? t('preview.sourceReal')
      : armSource === 'sim'
        ? t('preview.sourceSim')
        : t('preview.sourceUnknown')

  // 一条臂都认不到时也留一格空位：格子的位置不跟着数据出现/消失而跳
  const slots: (VrArmView | null)[] = arms.length > 0 ? arms : [null]

  return (
    // flex-1：吃掉中列除链路卡片之外的高度；min-h-16rem 是下限 —— 再挤就让格子滚动，
    // 而不是把 3D 视口压成一条缝
    <Card className="min-h-[16rem] flex-1 gap-2.5 rounded-[0.875rem] p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[0.90625rem] font-semibold text-foreground">
          <Box size="0.9375rem" /> {t('preview.title')}
        </div>
        <div className="font-mono text-[0.71875rem] text-muted-foreground">
          {t('preview.sourceLabel')} · {sourceLabel}
        </div>
      </div>

      <div className="flex gap-[0.3125rem]">
        <Button
          type="button"
          variant="outline"
          aria-pressed={showAxes}
          onClick={() => setShowAxes((v) => !v)}
          className={cn(
            'h-auto flex-1 rounded-[0.4375rem] py-[0.3125rem] text-xs font-normal text-ink-soft',
            showAxes && 'border-chip! bg-chip! text-chip-fg! hover:bg-chip! hover:text-chip-fg!',
          )}
        >
          {t('preview.axes')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => forEachView((view) => view.focus())}
          className="h-auto flex-1 rounded-[0.4375rem] py-[0.3125rem] text-xs font-normal text-ink-soft"
        >
          {t('preview.focus')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => forEachView((view) => view.topView())}
          className="h-auto flex-1 rounded-[0.4375rem] py-[0.3125rem] text-xs font-normal text-ink-soft"
        >
          {t('preview.topView')}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {slots.map((view) => (
          <ArmViewport key={view?.arm ?? ''} view={view} showAxes={showAxes} register={register} />
        ))}
      </div>
    </Card>
  )
}

/**
 * 一条臂的视口。订阅按臂分开：双臂时一条臂重画不会带着另一格一起重绘。
 *
 * 模型来源写在画面上：本页渲染的模型与控制页相同（见上方注释的已知偏差）。
 */
function ArmViewport({
  view,
  showAxes,
  register,
}: {
  view: VrArmView | null
  showAxes: boolean
  register: (key: string, handle: RobotViewportHandle | null) => void
}) {
  const { t } = useTranslation('vr')
  const handle = useRef<RobotViewportHandle | null>(null)
  const arm = view?.arm ?? null

  useEffect(() => {
    if (arm === null) return
    const apply = (q: number[]) => handle.current?.setJointPositions(q)
    // 先补一次当前值：订阅只给"之后"的变化，而这一格也可能刚挂上
    const current = vrLink.poseFor(arm)
    if (current) apply(current)
    return vrLink.subscribePose(arm, apply)
  }, [arm])

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-[0.625rem]">
      <Suspense
        fallback={
          <div className="absolute inset-0 flex items-center justify-center text-xs text-ink-faint">
            {t('preview.loading')}
          </div>
        }
      >
        <RobotViewport
          ref={(next) => {
            handle.current = next
            register(arm ?? '', next)
          }}
          showAxes={showAxes}
        />
      </Suspense>
      {/* 这一格画的是哪条臂：双臂时必须一眼看得出来 */}
      {view ? (
        <div className="absolute bottom-3 left-3.5 z-2 max-w-[calc(100%-5rem)] truncate rounded-[0.375rem] bg-[var(--overlay)] px-[0.4375rem] py-[0.1875rem] font-mono text-[0.6875rem] text-ink-muted">
          {view.arm}
          {view.device ? ` · ${view.device}` : ''}
        </div>
      ) : null}
      <div
        title={t('preview.modelHint')}
        className="absolute right-3.5 bottom-3 z-2 rounded-[0.375rem] bg-[var(--overlay)] px-[0.4375rem] py-[0.1875rem] font-mono text-[0.6875rem] text-ink-muted"
      >
        {t('preview.modelLabel', { model: RENDERED_MODEL_LABEL })}
      </div>
    </div>
  )
}
