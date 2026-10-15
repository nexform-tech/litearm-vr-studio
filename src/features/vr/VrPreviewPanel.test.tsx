import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { VrPreviewPanel } from './VrPreviewPanel'
import type { VrArmView } from './vrLink'

/**
 * 3D 预览：**一条臂一格**，姿态按臂走各自那条 16ms 通道。
 *
 * 真视口要 WebGL，jsdom 里跑不了，所以这里的 `RobotViewport` 换成一个只记账的替身：
 * 它记下"哪一格收到了哪组关节角、按钮点到了哪几格"。姿态从哪来（真机状态 `vr_arm`
 * 的 q、逐臂视图）在 `vrLink.test.ts` 里钉；这里钉的是面板怎么把它分给每一格。
 */

type Calls = { q: number[][]; focus: number; topView: number }

/** 替身与桩的状态：`vi.hoisted` 保证 mock 工厂里能拿到它 */
const stub = vi.hoisted(() => ({
  /** 每条臂"当前"的关节角（`vrLink.poseFor`） */
  poses: new Map<string, number[]>(),
  /** 每条臂的订阅者（`vrLink.subscribePose`） */
  subs: new Map<string, Set<(q: number[]) => void>>(),
  /** 按挂载顺序记下每一格收到了什么 */
  views: [] as Calls[],
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
  const RobotViewport = React.forwardRef((_props: unknown, ref: React.Ref<unknown>) => {
    const calls = React.useRef<Calls | null>(null)
    if (calls.current === null) {
      calls.current = { q: [], focus: 0, topView: 0 }
      stub.views.push(calls.current)
    }
    const own = calls.current
    React.useImperativeHandle(ref, () => ({
      setJointPositions: (q: number[]) => own.q.push(q),
      focus: () => {
        own.focus += 1
      },
      topView: () => {
        own.topView += 1
      },
    }))
    return React.createElement('div', { 'data-testid': 'viewport' })
  })
  return { RobotViewport }
})

const Q_A = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
const Q_B = [-0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7]

/** 一条臂的视图：面板只认这几个字段（`arm` / `device`），其余与这一格无关。 */
function armViewOf(arm: string, device: string): VrArmView {
  return { arm, device } as unknown as VrArmView
}

describe('VR 3D 预览 · 按臂', () => {
  beforeEach(async () => {
    stub.reset()
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('双臂一臂一格：格子标出自己那条臂，并订阅自己那条', () => {
    stub.poses.set('armA', Q_A)
    stub.poses.set('armB', Q_B)
    render(
      <VrPreviewPanel armSource="real" arms={[armViewOf('armA', '/dev/ttyACM0'), armViewOf('armB', 'can0')]} />,
    )

    expect(screen.getAllByTestId('viewport')).toHaveLength(2)
    // 一格画的是哪条臂：写在格子左下角
    expect(screen.getByText('armA · /dev/ttyACM0')).toBeTruthy()
    expect(screen.getByText('armB · can0')).toBeTruthy()
    expect([...stub.subs.keys()]).toEqual(['armA', 'armB'])
    // 挂上时先把各自最后一次真值补上（格子和数据可能不是同一拍到的）
    expect(stub.views.map((v) => v.q.at(-1))).toEqual([Q_A, Q_B])
  })

  it('姿态按臂推：只动一条臂时另一格收不到新值', () => {
    stub.poses.set('armA', Q_A)
    stub.poses.set('armB', Q_B)
    render(<VrPreviewPanel armSource="real" arms={[armViewOf('armA', 'dev/ttyACM0'), armViewOf('armB', 'can0')]} />)

    const before = stub.views.map((v) => v.q.length)
    const Q_B2 = Q_B.map((v) => v + 1)
    act(() => stub.push('armB', Q_B2))

    expect(stub.views[1].q).toHaveLength(before[1] + 1)
    expect(stub.views[1].q.at(-1)).toEqual(Q_B2)
    // 隔壁那格一帧都没多：两条臂的视口互不牵连
    expect(stub.views[0].q).toHaveLength(before[0])
  })

  it('一条臂都没认到也留一格空位，且不订阅任何臂', () => {
    render(<VrPreviewPanel armSource={null} arms={[]} />)

    expect(screen.getAllByTestId('viewport')).toHaveLength(1)
    expect(stub.subs.size).toBe(0)
    expect(stub.views[0].q).toEqual([])
    // 桥没连上时这一侧是仿真还是真机无从判断
    expect(screen.getByText(/未知（桥未连接）/)).toBeTruthy()
  })

  it('聚焦 / 俯视是对所有格子一起下的', () => {
    render(<VrPreviewPanel armSource="real" arms={[armViewOf('armA', 'can0'), armViewOf('armB', 'can1')]} />)

    fireEvent.click(screen.getByRole('button', { name: '聚焦' }))
    fireEvent.click(screen.getByRole('button', { name: '俯视' }))

    expect(stub.views.map((v) => v.focus)).toEqual([1, 1])
    expect(stub.views.map((v) => v.topView)).toEqual([1, 1])
  })
})
