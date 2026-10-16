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

/**
 * 假读数源：`vrBridge` 就长这样（见 useArmLoads 的 `ArmReadoutSource`）。
 *
 * `sides` 是桥在快照里报的槽位（`arm.side`）：它决定这条臂摆在哪一行。不写就是"桥没说"，
 * 那时按臂清单的顺序补空位（第一条补左、第二条补右）。
 */
function sourceOf(
  arms: string[],
  states: Record<string, Frame | null>,
  grips: Record<string, Frame | null> = {},
  sides: Record<string, 'left' | 'right'> = {},
): ArmReadoutSource {
  return {
    arms,
    snapshotFor: (arm) => (sides[arm] ? { arm: { side: sides[arm] } } : null),
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

/** 取一段（按槽位）：空槽没有臂身份，只能用 left / right 找。 */
function slotOf(side: 'left' | 'right'): HTMLElement {
  const found = screen.getAllByTestId('load-arm').find((el) => el.getAttribute('data-side') === side)
  if (!found) throw new Error(`没有 ${side} 那个槽`)
  return found
}

/** 断言档位而不是色值：颜色可以调，档位的含义不该跟着变 */
function levels(scope: HTMLElement = document.body): (string | null)[] {
  return within(scope)
    .queryAllByTestId('load-fill')
    .map((el) => el.getAttribute('data-level'))
}

/** 内置轴数 7 的那套行名 + 夹爪：认不到轴数时摆的就是这几行（面板的 `DEFAULT_JOINT_COUNT`）。 */
const EMPTY_ROWS = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', '夹爪']

/**
 * 断言"这一段摆着完整骨架、每个格子写"—""。
 *
 * 行名一个不少（顺序也钉住：关节行在前、夹爪在末）、条的个数就是行数（每个关节行和夹爪
 * 各一条）、"—"的个数＝3 格 × 行数，末一条最严：整段的行文就是"行名 + 三个—"。
 * 换句话说骨架里**一个数字都不许有** —— `0` / `0.00` / 百分比都是编数，"负载为 0"和
 * "没读到"在操作员眼里是两件事。
 *
 * 断在行容器（`load-rows`）上，不带段头的设备名：`/dev/ttyACM0` 自己带数字。
 */
function expectEmptyRows(rowsRoot: HTMLElement, names: string[]) {
  expect(within(rowsRoot).getAllByTestId('load-track')).toHaveLength(names.length)
  for (const name of names) expect(within(rowsRoot).getByText(name)).toBeTruthy()
  expect(within(rowsRoot).getAllByText('—')).toHaveLength(names.length * 3)
  expect(rowsRoot.textContent).toBe(names.map((name) => `${name}———`).join(''))
  // 不配色、不画额定标线：没有读数就没有档位与百分比可言
  expect(within(rowsRoot).queryAllByTestId('load-fill')).toHaveLength(0)
  expect(within(rowsRoot).queryAllByTestId('load-tick')).toHaveLength(0)
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

  it('桥一条臂都没认到：两个槽照样在，槽里没有臂、没有读数', () => {
    // 槽位是页面自己的结构（这一页盯的是左右两条臂），不随桥在不在变；但槽里**不编**
    // 一条臂出来 —— 臂身份是空串，读数一格都没有
    expect(loadsOf(sourceOf([], {}))).toEqual([
      { side: 'left', arm: '', device: '', status: 'missing', joints: [], gripper: null },
      { side: 'right', arm: '', device: '', status: 'missing', joints: [], gripper: null },
    ])
  })

  it('桥改口不再报某条臂时，它的峰值一起丢掉', () => {
    const peaks: PeakBook = new Map()
    loadsOf(
      sourceOf(['armA', 'armB'], { armA: armState([2]), armB: armState([3]) }),
      peaks,
    )
    expect(peaks.size).toBe(2)

    const after = loadsOf(sourceOf(['armA'], { armA: armState([2]) }), peaks)
    expect(after[0].arm).toBe('armA')
    expect(after[1].arm).toBe('') // 右槽空着，但槽还在
    expect([...peaks.keys()]).toEqual(['armA#0'])
  })
})

describe('电机负载 · 槽位（左臂在上、右臂在下）', () => {
  const dual = () =>
    loadsOf(
      sourceOf(
        ['armA', 'armB'],
        { armA: armState([1]), armB: armState([2]) },
        {},
        { armA: 'left', armB: 'right' },
      ),
    )

  it('槽位由桥报的 arm.side 定，不由臂身份的名字定', () => {
    // 身份跟着话题走、槽位跟着手柄走：这两件事不是一回事。故意把 B 放在左手柄那侧，
    // 页面就得照桥说的摆 —— 名字排序摆出来的顺序在改过接线的机器上是错的
    const views = loadsOf(
      sourceOf(
        ['armA', 'armB'],
        { armA: armState([1]), armB: armState([2]) },
        {},
        { armA: 'right', armB: 'left' },
      ),
    )

    expect(views.map((v) => [v.side, v.arm])).toEqual([
      ['left', 'armB'],
      ['right', 'armA'],
    ])
  })

  it('两个槽恒在：只有一条臂时另一个槽空着，第三条第臂跟在后头', () => {
    const one = loadsOf(sourceOf(['armA'], { armA: armState([1]) }, {}, { armA: 'right' }))
    expect(one.map((v) => [v.side, v.arm])).toEqual([
      ['left', ''],
      ['right', 'armA'],
    ])

    const three = loadsOf(
      sourceOf(['armA', 'armB', 'armC'], { armA: armState([1]), armB: armState([2]), armC: armState([3]) }),
    )
    // 桥没报槽位的两条按顺序补空位（第一条补左、第二条补右），补不进去的照旧跟在后面
    expect(three.map((v) => [v.side, v.arm])).toEqual([
      ['left', 'armA'],
      ['right', 'armB'],
      ['', 'armC'],
    ])
  })

  it('两个槽都排好后再轮到臂身份：读到的臂一条都不吞', () => {
    const views = dual()
    expect(views.map((v) => v.arm)).toEqual(['armA', 'armB'])
    expect(views.map((v) => v.side)).toEqual(['left', 'right'])
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

  it('夹爪条的蓝与"读不到额定值"的灰分得开', () => {
    // 额定值整份读不到 ⇒ 关节那几行也落在同一档（`unknown`）。两张条此时的 `data-level`
    // 一模一样，**颜色不该跟着一样**：这张表里灰说的是"读不到额定值、算不出档位"，
    // 而夹爪没有额定值是天经地义 —— 它要的是"这一行是夹爪"，不是"这行没数"。
    render(<VrMotorLoadPanel arms={dual()} rated={null} />)

    const fills = within(sectionOf('armA')).getAllByTestId('load-fill')
    const joint = fills[0]
    const gripper = fills.at(-1) as HTMLElement
    expect(joint.getAttribute('data-level')).toBe('unknown')
    expect(gripper.getAttribute('data-level')).toBe('unknown')
    expect(gripper.style.background).not.toBe(joint.style.background)
    // 而且不能是空色：`style.background` 读不出来时上面那条断言会假绿
    expect(gripper.style.background).not.toBe('')
  })

  it('没读到数的那一段照常摆表：7 行 + 夹爪都在，每格是"—"', () => {
    render(<VrMotorLoadPanel arms={dual()} rated={Array(7).fill(RATED)} />)

    // 另一条臂没读数：跟着有读数那条的轴数摆 7 行空位（同一台机器两臂同构）+ 夹爪
    const b = sectionOf('armB')
    expect(within(b).getByText('没数据')).toBeTruthy()
    expectEmptyRows(within(b).getByTestId('load-rows'), EMPTY_ROWS)
    // 一个色条都不画：空条与"负载为 0"必须看得出区别
    expect(levels(b)).toEqual([])
  })

  it('有臂、但没收到过 / 报断开 / 这一版不发 joints：三种都照摆 7 行', () => {
    const views = loadsOf(
      sourceOf(['armA', 'armB', 'armC'], {
        armA: null, // 真机状态一个字节都还没收到过
        armB: armState([1.2], { connected: false }), // 跟随服务自己报断开
        armC: armState([], { joints: null }), // sdk 版跟随服务根本不发 joints
      }),
    )
    render(<VrMotorLoadPanel arms={views} rated={Array(7).fill(RATED)} />)

    // 认得到臂就有它的段：一条不少，每段里 7 行 + 夹爪照摆
    expect(screen.getAllByTestId('load-arm')).toHaveLength(3)
    for (const arm of ['armA', 'armB', 'armC']) {
      expectEmptyRows(within(sectionOf(arm)).getByTestId('load-rows'), EMPTY_ROWS)
    }
    // 段头各自说清是哪种"没读到"
    expect(within(sectionOf('armA')).getByText('没数据')).toBeTruthy()
    expect(within(sectionOf('armB')).getByText('未连接')).toBeTruthy()
    expect(within(sectionOf('armC')).getByText('没数据')).toBeTruthy()
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
    // 断开的一臂照摆骨架（轴数跟着另一条有数的臂：1 轴 → J1 + 夹爪），
    // 上一帧的 1.2 不拿来当当前值
    expectEmptyRows(within(b).getByTestId('load-rows'), ['J1', '夹爪'])
    expect(levels(b)).toEqual([])
  })

  it('两条臂都没读数：两段都摆成 7 行 + 夹爪的空骨架', () => {
    const views = loadsOf(
      sourceOf(['armA', 'armB'], { armA: null, armB: null }, {}),
    )
    render(<VrMotorLoadPanel arms={views} rated={null} />)

    for (const arm of ['armA', 'armB']) {
      const section = sectionOf(arm)
      expectEmptyRows(within(section).getByTestId('load-rows'), EMPTY_ROWS)
      expect(levels(section)).toEqual([])
    }
    expect(screen.getAllByText('没数据')).toHaveLength(2)
  })

  it('没有 vr_grip 读数：夹爪那行还在，值写"—"', () => {
    // 这条臂有读数，但桥一帧夹爪状态都没报过：夹爪行不跟着消失
    const views = loadsOf(sourceOf(['armA'], { armA: armState([1.2, 0.4]) }))
    render(<VrMotorLoadPanel arms={views} rated={[RATED, RATED]} />)

    const rows = within(sectionOf('armA')).getByTestId('load-rows')
    const grip = within(rows).getByText('夹爪').parentElement as HTMLElement
    expect(within(grip).getAllByText('—')).toHaveLength(3)
    expect(within(grip).queryAllByTestId('load-fill')).toHaveLength(0)
    // 关节那几行照旧有数（这一条只管夹爪那行在不在）
    expect(within(rows).getByText('1.20 / 120 N·m')).toBeTruthy()
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

describe('电机负载表 · 两个固定的槽与已删掉的输入', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('zh')
  })
  afterEach(() => {
    localStorage.clear()
    cleanup()
  })

  it('一条臂都没认到：两个槽照样摆着，7 行 + 夹爪全写"—"，段头只有槽位名', () => {
    // 真话：桥连不上时这一页仍然摆出"左臂 / 右臂"两段空表。桥没起来只是"现在还没有数"，
    // 不是"没有可监控的量"：表收成一句空态，操作员读到的会是"这个功能不在这台机器上"，
    // 而结构在不在本身才是"这一页在监控什么"的说明
    render(<VrMotorLoadPanel arms={loadsOf(sourceOf([], {}))} rated={null} />)

    expect(screen.getAllByTestId('load-arm')).toHaveLength(2)
    expect(screen.getByText('左臂')).toBeTruthy()
    expect(screen.getByText('右臂')).toBeTruthy()
    // 左在上、右在下：不是"随便两段"，顺序就是操作员找读数的那条坐标
    const sections = screen.getAllByTestId('load-arm')
    expect(sections.map((el) => el.getAttribute('data-side'))).toEqual(['left', 'right'])
    // 占位话（"未认到臂"）不写：位置是固定的，认没认到臂由段头那两处空着说明
    expect(screen.queryByText('未认到臂')).toBeNull()
    // 表头那四列也在，两个槽各一份，和别的段一模一样
    for (const col of ['电机', '实时负载条', '当前', '本次峰值']) {
      expect(screen.getAllByText(col)).toHaveLength(2)
    }
    for (const side of ['left', 'right'] as const) {
      expectEmptyRows(within(slotOf(side)).getByTestId('load-rows'), EMPTY_ROWS)
    }
  })

  it('认到臂但一个字节都没收到：空槽与"有臂没数"分得开', () => {
    // 有臂的那一段照旧说"没数据"；没臂的那一段什么都不说 —— 两者都不是 0
    render(
      <VrMotorLoadPanel
        arms={loadsOf(sourceOf(['armB'], { armB: null }, {}, { armB: 'right' }))}
        rated={null}
      />,
    )

    expect(slotOf('left').getAttribute('data-arm')).toBe('')
    expect(within(slotOf('left')).queryByText('没数据')).toBeNull()
    expect(slotOf('right').getAttribute('data-arm')).toBe('armB')
    expect(within(slotOf('right')).getByText('没数据')).toBeTruthy()
    for (const side of ['left', 'right'] as const) {
      expectEmptyRows(within(slotOf(side)).getByTestId('load-rows'), EMPTY_ROWS)
    }
  })

  it('认到臂时三样都在：槽位名、臂身份、设备名', () => {
    render(
      <VrMotorLoadPanel
        arms={loadsOf(
          sourceOf(['armB'], { armB: armState([1]) }, {}, { armB: 'left' }),
        )}
        rated={[RATED]}
      />,
    )

    const left = slotOf('left')
    expect(within(left).getByText('左臂')).toBeTruthy()
    expect(within(left).getByText('armB')).toBeTruthy()
    expect(within(left).getByText('/dev/ttyACM0')).toBeTruthy()
    // 空着的右槽反过来：只有槽位名，没有身份、没有设备名
    const right = slotOf('right')
    expect(within(right).getByText('右臂')).toBeTruthy()
    expect(within(right).queryByText('armB')).toBeNull()
  })

  it('英文下这两个槽也说得出来（i18n 两种语言都要有）', async () => {
    await i18n.changeLanguage('en')
    render(<VrMotorLoadPanel arms={loadsOf(sourceOf([], {}))} rated={null} />)

    // 槽位名与夹爪行的名字在 en 里都要有：漏一个键，界面就会直接印出 `load.side.left`
    expect(screen.getByText('Left arm')).toBeTruthy()
    expect(screen.getByText('Right arm')).toBeTruthy()
    expectEmptyRows(
      within(slotOf('left')).getByTestId('load-rows'),
      ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'Gripper'],
    )
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
