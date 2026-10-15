import { Suspense, useEffect, useRef, useState } from 'react'
import { Box } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { RobotViewport, type RobotViewportHandle } from '@/components/RobotViewport'
import { cn } from '@/lib/utils'
import { vrLink } from './vrLink'
import type { VrArmSource } from './vrTypes'

/**
 * 机械臂 3D 预览：姿态走 16ms 通道直接推给视口，不经过 React 渲染循环。
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
export function VrPreviewPanel({ armSource }: { armSource: VrArmSource | null }) {
  const { t } = useTranslation('vr')
  const viewRef = useRef<RobotViewportHandle>(null)
  const [showAxes, setShowAxes] = useState(true)

  useEffect(() => {
    const apply = (q: number[]) => viewRef.current?.setJointPositions(q)
    const current = vrLink.jointAngles
    if (current) apply(current)
    return vrLink.subscribePose(apply)
  }, [])

  const sourceLabel =
    armSource === 'real'
      ? t('preview.sourceReal')
      : armSource === 'sim'
        ? t('preview.sourceSim')
        : t('preview.sourceUnknown')

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
          onClick={() => viewRef.current?.focus()}
          className="h-auto flex-1 rounded-[0.4375rem] py-[0.3125rem] text-xs font-normal text-ink-soft"
        >
          {t('preview.focus')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => viewRef.current?.topView()}
          className="h-auto flex-1 rounded-[0.4375rem] py-[0.3125rem] text-xs font-normal text-ink-soft"
        >
          {t('preview.topView')}
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[0.625rem]">
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center text-xs text-ink-faint">
              {t('preview.loading')}
            </div>
          }
        >
          <RobotViewport ref={viewRef} showAxes={showAxes} />
        </Suspense>
        <div className="absolute bottom-3 left-3.5 z-2 rounded-[0.375rem] bg-[var(--overlay)] px-[0.4375rem] py-[0.1875rem] font-mono text-[0.6875rem] text-ink-muted">
          {sourceLabel}
        </div>
        {/* 模型来源写在画面上：本页渲染的模型与控制页相同（见上方注释的已知偏差） */}
        <div
          title={t('preview.modelHint')}
          className="absolute right-3.5 bottom-3 z-2 rounded-[0.375rem] bg-[var(--overlay)] px-[0.4375rem] py-[0.1875rem] font-mono text-[0.6875rem] text-ink-muted"
        >
          {t('preview.modelLabel', { model: RENDERED_MODEL_LABEL })}
        </div>
      </div>
    </Card>
  )
}
