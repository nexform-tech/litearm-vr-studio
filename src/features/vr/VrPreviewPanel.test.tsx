import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { DUAL_ARM_MODEL, SINGLE_ARM_MODEL } from '@/components/robotModel'
import { VrPreviewPanel } from './VrPreviewPanel'
import type { VrArmView } from './vrLink'

/**
 * 3D 预览：**一个视图**，双臂时换成支架那份模型，两条链各由自己那条臂驱动。
 *
 * 真视口要 WebGL，jsdom 里跑不了，所以这里的 `RobotViewport` 换成一个只记账的替身：
 * 它记下"这个视口加载的是哪份模型、收到了哪组关节角、打给了哪条链、按钮点到没有"。
 * 姿态从哪来（真机状态 `vr_arm` 的 q、逐臂视图）在 `vrLink.test.ts` 里钉；这里钉的是
 * 面板怎么把它分给模型的各条链。
 */

type Call = { q: number[]; chain: string | undefined }
type View = {
  model: unknown
  calls: Call[]
  focus: number
  topView: number
}

/** 替身与桩的状态：`vi.hoisted` 保证 mock 工厂里能拿到它 */
const stub = vi.hoisted(() => ({
  /** 每条臂"当前"的关节角（`vrLink.poseFor`） */
  poses: new Map<string, number[]>(),
  /** 每条臂的订阅者（`vrLink.subscribePose`） */
  subs: new Map<string, Set<(q: number[]) => void>>(),
  /** 按挂载顺序记下每一个视口收到了什么 */
  views: [] as View[],
  reset() {
    this.poses.clear()
    this.subs.clear()
    this.views.length = 0
  },
  /** 推一组关节角给某条臂的订阅者（= 真机状态又报了一帧） */
  push(arm: string, q: number[]) {
    this.poses.set(arm, q)
    for (const cb of this.subs.get(arm) ?? []) cb(q)
  },
}))

vi.mock('./vrLink', () => ({
  vrLink: {
    poseFor: (arm: string) => stub.poses.get(arm) ?? null,
    subscribePose: (arm: string, cb: (q: number[]) => void) => {
      const set = stub.subs.get(arm) ?? new Set<(q: number[]) => void>()
      set.add(cb)
      stub.subs.set(arm, set)
      return () => {
        set.delete(cb)
      }
    },
  },
}))

vi.mock('@/components/RobotViewport', async () => {
  const React = await import('react')
  const RobotViewport = React.forwardRef(
    (props: { model?: unknown }, ref: React.Ref<unknown>) => {
      const view = React.useRef<View | null>(null)
      if (view.current === null) {
        view.current = { model: props.model, calls: [], focus: 0, topView: 0 }
        stub.views.push(view.current)
      }
      const own = view.current
      own.model = props.model
      React.useImperativeHandle(ref, () => ({
        setJointPositions: (q: number[], chain?: string) => own.calls.push({ q, chain }),
        focus: () => {
          own.focus += 1
        },
        topView: () => {
          own.topView += 1
        },
      }))
      return React.createElement('div', { 'data-testid': 'viewport' })
    },
  )
  return { RobotViewport }
})

const Q_A = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
const Q_B = [-0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7]

/** 一条臂的视图：面板只认这几个字段（`arm` / `side` / `device`），其余与这个视图无关。 */
function armViewOf(arm: string, side: string, device = ''): VrArmView {
  return { arm, side, device } as unknown as VrArmView
}

describe('VR 3D 预览 · 一个视图', () => {
  beforeEach(async () => {
    stub.reset()
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('双臂：一个视口 + 支架模型，两条链各收自己那条臂的角', () => {
    stub.poses.set('armA', Q_A)
    stub.poses.set('armB', Q_B)
    render(
      <VrPreviewPanel
        armSource="real"
        arms={[armViewOf('armA', 'left', '/dev/ttyACM0'), armViewOf('armB', 'right', '/dev/ttyACM1')]}
      />,
    )

    // 一个视图，画的是**一台机器**（两条侧装臂挂在一根立柱上），不是两台并排的立式臂
    expect(screen.getAllByTestId('viewport')).toHaveLength(1)
    expect(stub.views[0].model).toBe(DUAL_ARM_MODEL)
    // 挂上时先把各自最后一次真值补上，并各自打给**按安装侧**选中的那条链
    expect(stub.views[0].calls).toEqual([
      { q: Q_A, chain: 'left' },
      { q: Q_B, chain: 'right' },
    ])
    // 画面左下角列出这个视图里画着哪几条臂（对回映射卡靠它）
    expect(screen.getByText('armA · armB')).toBeTruthy()
  })

  it('单臂：立式模型，角打给唯一那条链', () => {
    stub.poses.set('armA', Q_A)
    render(<VrPreviewPanel armSource="real" arms={[armViewOf('armA', 'left')]} />)

    expect(screen.getAllByTestId('viewport')).toHaveLength(1)
    expect(stub.views[0].model).toBe(SINGLE_ARM_MODEL)
    expect(stub.views[0].calls).toEqual([{ q: Q_A, chain: '' }])
  })

  it('姿态按臂推：只动一条臂时另一条链收不到新值', () => {
    stub.poses.set('armA', Q_A)
    stub.poses.set('armB', Q_B)
    render(
      <VrPreviewPanel
        armSource="real"
        arms={[armViewOf('armA', 'left'), armViewOf('armB', 'right')]}
      />,
    )

    const before = stub.views[0].calls.length
    const Q_B2 = Q_B.map((v) => v + 1)
    act(() => stub.push('armB', Q_B2))

    const after = stub.views[0].calls.slice(before)
    expect(after).toEqual([{ q: Q_B2, chain: 'right' }])
  })

  it('桥没报安装侧时按次序兜底，而不是两条臂叠在一条链上', () => {
    stub.poses.set('armA', Q_A)
    stub.poses.set('armB', Q_B)
    render(
      <VrPreviewPanel armSource="real" arms={[armViewOf('armA', ''), armViewOf('armB', '')]} />,
    )

    expect(stub.views[0].calls).toEqual([
      { q: Q_A, chain: 'left' },
      { q: Q_B, chain: 'right' },
    ])
  })

  it('臂数一变就换模型（单臂 ⇄ 双臂）', () => {
    const { rerender } = render(
      <VrPreviewPanel armSource="real" arms={[armViewOf('armA', 'left')]} />,
    )
    expect(stub.views[0].model).toBe(SINGLE_ARM_MODEL)

    rerender(
      <VrPreviewPanel
        armSource="real"
        arms={[armViewOf('armA', 'left'), armViewOf('armB', 'right')]}
      />,
    )
    expect(stub.views.at(-1)?.model).toBe(DUAL_ARM_MODEL)
  })

  it('一条臂都没认到也留一个空视口，且不订阅任何臂', () => {
    render(<VrPreviewPanel armSource={null} arms={[]} />)

    expect(screen.getAllByTestId('viewport')).toHaveLength(1)
    expect(stub.subs.size).toBe(0)
    expect(stub.views[0].calls).toEqual([])
    // 仿真还是真机无从判断时就说"未知"：真机状态没来（或跟随服务没连着）时，
    // 这一栏说"仿真姿态"就是编的
    expect(screen.getByText(/未知/)).toBeTruthy()
  })

  it('聚焦 / 俯视打在这一个视口上', () => {
    render(<VrPreviewPanel armSource="real" arms={[armViewOf('armA', 'left')]} />)

    fireEvent.click(screen.getByRole('button', { name: '聚焦' }))
    fireEvent.click(screen.getByRole('button', { name: '俯视' }))

    expect(stub.views[0].focus).toBe(1)
    expect(stub.views[0].topView).toBe(1)
  })
})
