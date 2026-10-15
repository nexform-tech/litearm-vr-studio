import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import i18n from '@/i18n'
import { VrMotorLoadPanel } from './VrMotorLoadPanel'
import { readArmLoads, type ArmLoadView, type ArmReadoutSource, type PeakBook } from './useArmLoads'

/**
 * 电机负载表：数从哪来、条怎么分档、**没读到数时说什么**。
 *
 * 读数来源是上游汇总服务发的真机状态（`vr_arm` 的 `joints.tau` / `t_mos` / `t_coil`，
 * 夹爪在 `vr_grip`），不是上位机那条本机串口链路 —— VR 遥操时串口在跟随服务手里。
 * 所以这里的载荷照 `litearm-vr-follow/status_msgs.py` 的 `ArmStatus` / `GripperStatus`
 * 写成真形状，而不是顺手编一个 `{tau: 3}`。
 *
 * 条的配色靠 inline style / `data-level` 断言，不去猜 class。
 */

type Frame = Record<string, unknown>

const RATED = 120

/** 一条臂的真机状态（`ArmStatus.to_dict()` 的形状，stm32 版：带 joints）。 */
function armState(tau: number[], over: Frame = {}): Frame {
  const zeros = tau.map(() => 0)
  return {
    device: '/dev/ttyACM0',
    connected: true,
    ok: true,
    source: 'stm32',
    state: 'following',
    mode: null,
    enabled: true,
    following: true,
    flags: [],
    fault: [],
    joint_fault: null,
    q: zeros,
    target: null,
    anchor: null,
    cmd_q: null,
    joints: {
      q: zeros,
      dq: zeros,
      tau,
      // 两个温度是并行数组（℃）：MOS 板温 / 线圈温度
      t_mos: tau.map((_, i) => 40 + i),
      t_coil: tau.map((_, i) => 30 + i),
      err: zeros,
    },
    age_ms: 12.5,
    error: null,
    ...over,
  }
}

/** 夹爪的真机状态（`GripperStatus.to_dict()`）。 */
function gripState(over: Frame = {}): Frame {
  return {
    device: 'can0',
    connected: true,
    ok: true,
    q: 0.31,
    tau: 1.25,
    enabled: true,
    error_code: 0,
    age_ms: 12.5,
    error: null,
    ...over,
  }
}

/** 假读数源：`vrBridge` 就长这样（见 useArmLoads 的 `ArmReadoutSource`）。 */
function sourceOf(
  arms: string[],
  states: Record<string, Frame | null>,
  grips: Record<string, Frame | null> = {},
): ArmReadoutSource {
  return {
    arms,
    armStateFor: (arm) => states[arm] ?? null,
    gripStateFor: (arm) => grips[arm] ?? null,
  }
}

/** 一次采样就是读一遍（面板只吃读出来的结果，不认数据源）。 */
function loadsOf(src: ArmReadoutSource, peaks: PeakBook = new Map()): ArmLoadView[] {
  return readArmLoads(src, peaks)
}

/** 取一段（按臂身份）：两条臂的行名一样，断言得限定在段内。 */
function sectionOf(arm: string): HTMLElement {
  const found = screen.getAllByTestId('load-arm').find((el) => el.getAttribute('data-arm') === arm)
  if (!found) throw new Error(`没有 ${arm} 那一段`)
  return found
}

/** 断言档位而不是色值：颜色可以调，档位的含义不该跟着变 */
function levels(scope: HTMLElement = document.body): (string | null)[] {
  return within(scope)
    .queryAllByTestId('load-fill')
    .map((el) => el.getAttribute('data-level'))
}

/**
 * 读数来源：真机状态里有什么就是什么。
 *
 * 这一组钉的全是"没读到"与"读到 0"的区别 —— 填 0 会让操作员以为机械臂没在使劲。
 */
describe('电机负载 · 读数来源（真机状态）', () => {
  it('tau 逐轴取自 vr_arm 的 joints.tau，峰值只涨不落', () => {
    const peaks: PeakBook = new Map()
    const first = loadsOf(sourceOf(['armA'], { armA: armState([-5.09, 0.43]) }), peaks)[0]

    expect(first.arm).toBe('armA')
    expect(first.device).toBe('/dev/ttyACM0')
    expect(first.status).toBe('live')
    expect(first.joints.map((row) => row.tau)).toEqual([-5.09, 0.43])
    expect(first.joints.map((row) => row.peak)).toEqual([5.09, 0.43])

    // 下一拍变小：峰值不跟着回落
    const second = loadsOf(sourceOf(['armA'], { armA: armState([-1, 0.1]) }), peaks)[0]
    expect(second.joints.map((row) => row.tau)).toEqual([-1, 0.1])
    expect(second.joints.map((row) => row.peak)).toEqual([5.09, 0.43])
  })

  it('跟随服务报断开时，那几组数组不当当前值：读数留空、峰值也清掉', () => {
    const peaks: PeakBook = new Map()
    loadsOf(sourceOf(['armA'], { armA: armState([-5.09, 0.43]) }), peaks)
    expect(peaks.size).toBe(2)

    // 真机状态报断开：数组可能还是上一帧的量，拿它当"当前值"比空着更危险
    const offline = loadsOf(
      sourceOf(['armA'], { armA: armState([-5.09, 0.43], { connected: false, state: 'error' }) }),
      peaks,
    )[0]

    expect(offline.status).toBe('offline')
    expect(offline.joints).toEqual([])
    expect(peaks.size).toBe(0) // 本次连接到此为止，峰值不留
  })

  it('这一帧一个字节都没收到过：missing，而不是 0', () => {
    const view = loadsOf(sourceOf(['armA'], { armA: null }))[0]

    expect(view.status).toBe('missing')
    expect(view.joints).toEqual([])
    expect(view.device).toBe('')
  })

  it('这一版跟随服务不发 joints（sdk 版就是）：连着也没有读数', () => {
    // 上游文档写明 joints 只有 stm32 版有，sdk 版缺省为 null
    const view = loadsOf(sourceOf(['armA'], { armA: armState([], { joints: null }) }))[0]

    expect(view.status).toBe('missing')
    expect(view.joints).toEqual([])
  })

  it('数组里的空洞与非数一律算"没读到"，不当 0', () => {
    const view = loadsOf(
      sourceOf(['armA'], {
        armA: armState([], {
          joints: { tau: [1.5, null, 'x'], t_mos: [41.5], t_coil: [null, 33.25, 34.0], err: [] },
        }),
      }),
    )[0]

    expect(view.joints).toHaveLength(3)
    expect(view.joints[0].tau).toBe(1.5)
    expect(view.joints[1].tau).toBeNull()
    expect(view.joints[2].tau).toBeNull()
    // 温度是短的并行数组：缺的那几位同样是"没读到"
    expect(view.joints[0].tMos).toBe(41.5)
    expect(view.joints[1].tMos).toBeNull()
    expect(view.joints[0].tCoil).toBeNull()
    expect(view.joints[1].tCoil).toBe(33.25)
  })

  it('夹爪那行取 vr_grip 的 tau；没收到过就是 null', () => {
    const withGrip = loadsOf(
      sourceOf(['armA'], { armA: armState([1]) }, { armA: gripState() }),
    )[0]
    expect(withGrip.gripper?.tau).toBe(1.25)
    expect(withGrip.gripper?.peak).toBe(1.25)
    // 夹爪没有温度这项
    expect(withGrip.gripper?.tMos).toBeUndefined()

    const noGrip = loadsOf(sourceOf(['armA'], { armA: armState([1]) }))[0]
    expect(noGrip.gripper).toBeNull()

    const gripOffline = loadsOf(
      sourceOf(['armA'], { armA: armState([1]) }, { armA: gripState({ connected: false, tau: 1.25 }) }),
    )[0]
    expect(gripOffline.gripper?.tau).toBeNull()
  })

  it('桥一条臂都没认到就不编一段出来', () => {
    expect(loadsOf(sourceOf([], {}))).toEqual([])
  })

  it('桥改口不再报某条臂时，它的峰值一起丢掉', () => {
    const peaks: PeakBook = new Map()
    loadsOf(
      sourceOf(['armA', 'armB'], { armA: armState([2]), armB: armState([3]) }),
      peaks,
    )
    expect(peaks.size).toBe(2)

    const left = loadsOf(sourceOf(['armA'], { armA: armState([2]) }), peaks)
    expect(left.map((view) => view.arm)).toEqual(['armA'])
    expect([...peaks.keys()]).toEqual(['armA#0'])
  })
})

describe('电机负载表 · 双臂', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  const dual = () =>
    loadsOf(
      sourceOf(
        ['armA', 'armB'],
        {
          armA: armState([-5.09, 0.43, 3, 110, 130, -0.5, 0.2]),
          armB: armState([], {
            device: 'can0',
            joints: null,
            state: 'error',
          }),
        },
        { armA: gripState() },
      ),
    )

  it('两条臂各占一段：身份与设备名各是自己的', () => {
    render(<VrMotorLoadPanel arms={dual()} rated={Array(7).fill(RATED)} />)

    const sections = screen.getAllByTestId('load-arm')
    expect(sections).toHaveLength(2)
    expect(sectionOf('armA').textContent).toContain('armA')
    expect(sectionOf('armA').textContent).toContain('/dev/ttyACM0')
    expect(sectionOf('armB').textContent).toContain('armB')
    expect(sectionOf('armB').textContent).toContain('can0')
    // 有数的那段不写状态，没数的那段写明是"没数据"（sdk 版不发 joints）
    expect(sectionOf('armA').getAttribute('data-status')).toBe('live')
    expect(sectionOf('armB').getAttribute('data-status')).toBe('missing')
  })

  it('每轴一行：当前 / 峰值 / 额定百分比，末尾是夹爪行', () => {
    render(<VrMotorLoadPanel arms={dual()} rated={Array(7).fill(RATED)} />)

    const a = sectionOf('armA')
    expect(within(a).getByText('J1')).toBeTruthy()
    expect(within(a).getByText('J7')).toBeTruthy()
    // 条上写"|当前| / 额定"，与原图一致
    expect(within(a).getByText('5.09 / 120 N·m')).toBeTruthy()
    expect(within(a).getByText('-5.09 N·m (4%)')).toBeTruthy()
    expect(within(a).getByText('5.09 N·m')).toBeTruthy()
    // 末尾一行夹爪，读的是 vr_grip 的 tau（夹爪没有额定值这一说，条上照实写）
    const grip = within(a).getByText('夹爪').parentElement as HTMLElement
    expect(within(grip).getByText('1.25 / 未读到额定值')).toBeTruthy()
    // 第一拍当前值与峰值相同，两格都写 1.25
    expect(within(grip).getAllByText('1.25 N·m')).toHaveLength(2)
  })

  it('没读到数的那一段照常摆表：空条 + "—"，段头写明状态', () => {
    render(<VrMotorLoadPanel arms={dual()} rated={Array(7).fill(RATED)} />)

    // 另一条臂没读数：跟着有读数那条的轴数摆 7 行空位（同一台机器两臂同构）+ 夹爪
    const b = sectionOf('armB')
    expect(within(b).getByText('没数据')).toBeTruthy()
    expect(within(b).getAllByTestId('load-track')).toHaveLength(8)
    // 一个色条都不画：空条与"负载为 0"必须看得出区别
    expect(levels(b)).toEqual([])
    expect(b.textContent).not.toContain('0.00')
  })

  it('跟随服务报断开的那一段写"未连接"，同样不编数', () => {
    const views = loadsOf(
      sourceOf(['armA', 'armB'], {
        armA: armState([1.2]),
        armB: armState([1.2], { connected: false }),
      }),
    )
    render(<VrMotorLoadPanel arms={views} rated={[RATED]} />)

    const b = sectionOf('armB')
    expect(b.getAttribute('data-status')).toBe('offline')
    expect(within(b).getByText('未连接')).toBeTruthy()
    expect(levels(b)).toEqual([])
    expect(b.textContent).not.toContain('1.20')
  })

  it('两条臂都没读数：两段都按内置轴数摆空位', () => {
    const views = loadsOf(
      sourceOf(['armA', 'armB'], { armA: null, armB: null }, {}),
    )
    render(<VrMotorLoadPanel arms={views} rated={null} />)

    expect(levels()).toEqual([])
    // 2 ×（7 轴 + 夹爪）
    expect(screen.getAllByTestId('load-track')).toHaveLength(16)
    expect(screen.getAllByText('没数据')).toHaveLength(2)
  })
})

describe('电机负载表 · 分档与额定', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })
  afterEach(() => cleanup())

  it('按额定分档：≤85% 绿、85–100% 黄、超额定红', () => {
    // 120 N·m 额定下：3、110、130
    const views = loadsOf(sourceOf(['armA'], { armA: armState([3, 110, -130]) }))
    render(<VrMotorLoadPanel arms={views} rated={[RATED, RATED, RATED]} />)

    expect(levels()).toEqual(['ok', 'warn', 'danger'])
  })

  it('没读到额定值时：不编百分比，也不给颜色分档', () => {
    const views = loadsOf(sourceOf(['armA'], { armA: armState([4.2]) }))
    render(<VrMotorLoadPanel arms={views} rated={null} />)

    expect(screen.getByText('4.20 / 未读到额定值')).toBeTruthy()
    // 整张表里没有一处百分比（当前值那格读作 "4.20 N·m"，不带 "(x%)"）
    expect(screen.queryByText(/\(\d+%\)/)).toBeNull()
    expect(levels()).toEqual(['unknown'])
    expect(screen.queryAllByTestId('load-tick')).toHaveLength(0)
  })

  it('超出额定时刻度跟着峰值走，额定标线留在条内', () => {
    // 第一拍冲到额定的两倍，第二拍回落到 60：峰值仍在，"当前"读数还得画得下
    const peaks: PeakBook = new Map()
    loadsOf(sourceOf(['armA'], { armA: armState([240]) }), peaks)
    const views = loadsOf(sourceOf(['armA'], { armA: armState([60]) }), peaks)
    render(<VrMotorLoadPanel arms={views} rated={[RATED]} />)

    // 刻度 = max(额定 120, 峰值 240) = 240 → 标线落在 50%
    const tick = screen.getByTestId('load-tick') as HTMLElement
    expect(tick.style.left).toBe('50%')
    const fill = screen.getByTestId('load-fill') as HTMLElement
    expect(fill.style.width).toBe('25%') // 60 / 240
  })

  it('温度挂在"本次峰值"那一格上，悬停可看（不占一整行）', () => {
    const views = loadsOf(sourceOf(['armA'], { armA: armState([-5.09, 0.43]) }))
    render(<VrMotorLoadPanel arms={views} rated={[RATED, RATED]} />)

    // J1 的温度是 40.0 / 30.0（见 armState 的造数），J2 依次 +1
    expect(screen.getByText('5.09 N·m').getAttribute('title')).toBe('MOS 40.0 ℃ · 线圈 30.0 ℃')
    expect(screen.getByText('0.43 N·m').getAttribute('title')).toBe('MOS 41.0 ℃ · 线圈 31.0 ℃')
  })
})

describe('电机负载表 · 空态与已删掉的输入', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('zh')
  })
  afterEach(() => {
    localStorage.clear()
    cleanup()
  })

  it('一条臂都没认到：不摆空表，直说没有可监控的量', () => {
    render(<VrMotorLoadPanel arms={[]} rated={null} />)

    expect(screen.queryAllByTestId('load-arm')).toHaveLength(0)
    expect(screen.queryAllByTestId('load-track')).toHaveLength(0)
    expect(screen.getByText(/没收到机械臂快照/)).toBeTruthy()
  })

  it('数据话题那四个输入框已经不在了，本机也不再存话题', () => {
    render(<VrMotorLoadPanel arms={loadsOf(sourceOf(['armA'], { armA: armState([1]) }))} rated={[RATED]} />)

    // 话题名是桥/daemon 那一侧的配置，页面不再自己编一个让操作员填
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByLabelText(/遥测/)).toBeNull()
    expect(localStorage.getItem('vr_motor_topics')).toBeNull()
  })
})
