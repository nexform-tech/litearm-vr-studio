import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { VrMotorLoadPanel, type ArmLoadTable } from './VrMotorLoadPanel'
import type { MotorLoad } from './useMotorLoad'

/**
 * 电机负载表：数从哪来（上位机链路的 tau）、条怎么分档、没接线的一侧说什么、
 * 话题名存不存得住 —— 这几件事都在这里钉住。条的配色靠 inline style 断言，不去猜 class。
 */

const load = (tau: number, peak: number, rated: number | null = 120): MotorLoad => ({ tau, peak, rated })

const arm = (rows: MotorLoad[], extra: Partial<ArmLoadTable> = {}): ArmLoadTable => ({
  live: true,
  rows,
  gripper: null,
  ...extra,
})

const NOT_WIRED: ArmLoadTable = { live: false, rows: [], gripper: null }

/** 断言档位而不是色值：颜色可以调，档位的含义不该跟着变 */
function levels(): (string | null)[] {
  return screen.getAllByTestId('load-fill').map((el) => el.getAttribute('data-level'))
}

describe('电机负载表', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('zh')
  })
  afterEach(() => {
    localStorage.clear()
    cleanup()
  })

  it('每轴一行，读数是"当前 / 峰值"，并按额定给出百分比；末尾是夹爪行', () => {
    render(<VrMotorLoadPanel left={arm([load(-5.09, 31.45), load(0.43, 11.25)])} right={NOT_WIRED} />)

    // 左右两段各摆一行 J1/J2：左臂是读数，右臂是空位
    expect(screen.getAllByText('J1')).toHaveLength(2)
    expect(screen.getAllByText('J2')).toHaveLength(2)
    // 条上写的是"|当前| / 额定"，与原图一致
    expect(screen.getByText('5.09 / 120 N·m')).toBeTruthy()
    expect(screen.getByText('-5.09 N·m (4%)')).toBeTruthy()
    expect(screen.getByText('31.45 N·m')).toBeTruthy()
    // 两侧末尾各一行夹爪，都还没有读数：条照画（空条），两列是"—"
    expect(screen.getAllByText('夹爪')).toHaveLength(2)
    // 空条：左夹爪 + 右臂 J1/J2 空位 + 右夹爪
    expect(screen.getAllByTestId('load-track')).toHaveLength(4)
  })

  it('按额定分档：≤85% 绿、85–100% 黄、超额定红', () => {
    // 120 N·m 额定下：3、110、130
    render(<VrMotorLoadPanel left={arm([load(3, 31), load(110, 110), load(-130, 130)])} right={NOT_WIRED} />)

    expect(levels()).toEqual(['ok', 'warn', 'danger'])
  })

  it('没读到额定值时：不编百分比，也不给颜色分档', () => {
    render(<VrMotorLoadPanel left={arm([load(4.2, 9.9, null)])} right={NOT_WIRED} />)

    expect(screen.getByText('4.20 / 未读到额定值')).toBeTruthy()
    expect(screen.getByText('4.20 N·m')).toBeTruthy() // 当前值没有 "(x%)"
    expect(levels()).toEqual(['unknown'])
    expect(screen.queryAllByTestId('load-tick')).toHaveLength(0)
  })

  it('超出额定时刻度跟着峰值走，额定标线留在条内', () => {
    render(<VrMotorLoadPanel left={arm([load(60, 240)])} right={NOT_WIRED} />)

    const tick = screen.getByTestId('load-tick') as HTMLElement
    // 刻度 = max(额定 120, 峰值 240) = 240 → 标线落在 50%
    expect(tick.style.left).toBe('50%')
    const fill = screen.getByTestId('load-fill') as HTMLElement
    expect(fill.style.width).toBe('25%') // 60 / 240
  })

  it('没接线的那一侧照常摆出表：空条 + "—"，不填任何数', () => {
    // 左臂 7 轴有数，右臂没接：右侧要跟着 7 轴摆空位，而不是变成一句说明
    const seven = Array.from({ length: 7 }, () => load(0.5, 0.5, 10))
    render(<VrMotorLoadPanel left={arm(seven)} right={NOT_WIRED} />)

    expect(screen.getByText('右臂')).toBeTruthy()
    expect(screen.getByText('未连接')).toBeTruthy()
    // J1–J7 两段各一次
    expect(screen.getAllByText('J7')).toHaveLength(2)
    // 空条：右臂 7 轴 + 夹爪，外加左臂那行没接线的夹爪
    expect(screen.getAllByTestId('load-fill')).toHaveLength(7)
    expect(screen.getAllByTestId('load-track')).toHaveLength(9)
  })

  it('两侧都没接线时，两段都按内置轴数摆空位', () => {
    render(<VrMotorLoadPanel left={NOT_WIRED} right={NOT_WIRED} />)

    expect(screen.queryAllByTestId('load-fill')).toHaveLength(0)
    expect(screen.getAllByText('未连接')).toHaveLength(2)
    // 2 ×（7 轴 + 夹爪）
    expect(screen.getAllByTestId('load-track')).toHaveLength(16)
  })

  it('数据话题：四个话题名，应用后存到本机', () => {
    render(<VrMotorLoadPanel left={NOT_WIRED} right={NOT_WIRED} />)

    for (const label of ['左臂电机遥测', '右臂电机遥测', '左夹爪遥测', '右夹爪遥测']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
    fireEvent.change(screen.getByLabelText('左臂电机遥测'), {
      target: { value: '/openarmx_left_hardware_params/motor_torque' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用话题' }))

    expect(screen.getByText('已存到本机')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('vr_motor_topics') ?? '{}').leftArm).toBe(
      '/openarmx_left_hardware_params/motor_torque',
    )
  })
})
