import { Suspense, useEffect, useRef, useState } from 'react'
import { Box } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { RobotViewport, type RobotViewportHandle } from '@/components/RobotViewport'
import { DUAL_ARM_MODEL, SINGLE_ARM_MODEL, type RobotModel } from '@/components/robotModel'
import { cn } from '@/lib/utils'
import { vrLink, type VrArmView } from './vrLink'
import type { VrArmSource } from './vrTypes'

/**
 * 机械臂 3D 预览：**一个视图**，姿态走 16ms 通道直接推给视口，不经过 React 渲染循环。
 *
 * 视图只有一个，因为它画的是**一台机器**：
 *
 *   * 单臂 —— 机械臂自己那份立式模型（与控制页同一份，见 `robotModel.ts`）；
 *   * 双臂 —— 支架那份（`dual_litearm_column_description`）：两条**侧装**臂挂在同一根
 *     立柱上，`left_*` / `right_*` 两条链各由自己那条臂的关节角驱动。
 *
 * 以前是"一条臂一格"，于是双臂时画面上并排两台互不相干的立式臂 —— 那既不是现场的装配，
 * 也说不出"这两条臂是一台机器上的"。臂身份（`armA`）只决定**是谁**，装在哪一侧由桥的
 * `arm.side` 说，链就按它选（见 `chainFor`）。
 *
 * 关节角取自真机状态（`vr_arm` 的 `q`，见 `vrLink` 的逐臂视图）：桥掉线后画面停在最后一次
 * 真值上（不是零位），卡片右上角的数据源会说"未知"。
 *
 * ⚠ 模型与控制页那份**不同源**，这是有意的：VR 这条路报上来的关节角是 metavr 按它自己那份
 *   URDF 解出来的（见 litearm-vr-bridge docs/DESIGN.md 8.3），拿 studio 那份去画双臂，关节
 *   origin/轴向/限位都对不上（实测同一组 q 末端位姿差 2~4cm、姿态差约 90°）。单臂那份仍是
 *   控制页的模型，所以单臂时那条已知偏差照旧存在 —— 画面右下角的模型标签说的是实话。
 */
const MODEL_LABEL_OF: Record<string, string> = {
  [SINGLE_ARM_MODEL.label]: 'preview.modelHint',
  [DUAL_ARM_MODEL.label]: 'preview.modelHintDual',
}

/**
 * 这份姿态该驱动模型的哪条链。
 *
 * 优先按桥报的**安装侧**（`arm.side`，就是映射卡上那两个"左臂/右臂"）；它缺席时按臂的
 * 次序兜底 —— 认到两条臂却都不知道装在哪时，至少让它们分别驱动两条链，而不是叠在一条上。
 */
function chainFor(model: RobotModel, arm: VrArmView, index: number): string {
  const bySide = model.chains.find((chain) => chain.id !== '' && chain.id === arm.side)
  if (bySide) return bySide.id
  return model.chains[Math.min(index, model.chains.length - 1)].id
}

/**
 * `armSource` 为 null = 桥没连上，这一侧是仿真还是真机**无从判断**，别猜。
 */
export function VrPreviewPanel({
  armSource,
  arms,
}: {
  armSource: VrArmSource | null
  /** 逐臂视图（`useVrLink().arms`）：一条臂一份状态，一起画进这一个视图里 */
  arms: VrArmView[]
}) {
  const { t } = useTranslation('vr')
  const [showAxes, setShowAxes] = useState(true)
  const view = useRef<RobotViewportHandle | null>(null)

  // 两条以上才切支架模型：一条臂时画的就是"这台机器只有一条立式臂"
  const model = arms.length > 1 ? DUAL_ARM_MODEL : SINGLE_ARM_MODEL
  // 臂清单与侧别都在这两样里；臂数一变模型就要换，所以它得进依赖
  const armKey = arms.map((arm) => `${arm.arm}:${arm.side}`).join('\u0000')

  useEffect(() => {
    if (arms.length === 0) return
    const offs = arms.map((arm, index) => {
      const chain = chainFor(model, arm, index)
      const apply = (q: number[]) => view.current?.setJointPositions(q, chain)
      // 先补一次当前值：订阅只给"之后"的变化，而这个视图也可能刚挂上（或刚换了模型）
      const current = vrLink.poseFor(arm.arm)
      if (current) apply(current)
      return vrLink.subscribePose(arm.arm, apply)
    })
    return () => {
      for (const off of offs) off()
    }
    // `armKey` 而不是 `arms`：每次 emit 都是新数组，拿它当依赖会一直重建订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armKey, model])

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

  return (
    // flex-1：吃掉中列除链路卡片之外的高度；min-h-16rem 是下限 —— 再挤就让视口滚动，
    // 而不是把 3D 画成一条缝
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
          onClick={() => view.current?.focus()}
          className="h-auto flex-1 rounded-[0.4375rem] py-[0.3125rem] text-xs font-normal text-ink-soft"
        >
          {t('preview.focus')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => view.current?.topView()}
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
          {/* `key` 让换模型时**重挂**这个视口：URDF 是加载时定的，改 prop 不会重载 */}
          <RobotViewport
            key={model.label}
            ref={(next) => {
              view.current = next
            }}
            model={model}
            showAxes={showAxes}
          />
        </Suspense>
        {/* 这一个视图里画着哪几条臂：双臂时臂身份是画面上唯一能对回映射卡的东西 */}
        {arms.length > 0 ? (
          <div className="absolute bottom-3 left-3.5 z-2 max-w-[calc(100%-8rem)] truncate rounded-[0.375rem] bg-[var(--overlay)] px-[0.4375rem] py-[0.1875rem] font-mono text-[0.6875rem] text-ink-muted">
            {arms.map((arm) => arm.arm).join(' · ')}
          </div>
        ) : null}
        <div
          title={t(MODEL_LABEL_OF[model.label] ?? 'preview.modelHint')}
          className="absolute right-3.5 bottom-3 z-2 rounded-[0.375rem] bg-[var(--overlay)] px-[0.4375rem] py-[0.1875rem] font-mono text-[0.6875rem] text-ink-muted"
        >
          {t('preview.modelLabel', { model: model.label })}
        </div>
      </div>
    </Card>
  )
}
