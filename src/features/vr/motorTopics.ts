/**
 * 电机遥测的四个话题名（左臂 / 右臂 / 左夹爪 / 右夹爪）。
 *
 * ⚠ 现在**没有任何东西消费它们**：接线还没定（双臂数据从哪一路来见 `useMotorLoad` 的说明）。
 * 存本机只是为了让现场填过一次就别再填 —— 与桥地址同一个教训：话题名因现场而异，
 * 猜一个默认值写进界面，错法是"静默地连错"，比空着难查得多。
 */

const LS_KEY = 'vr_motor_topics'

export type MotorTopics = {
  leftArm: string
  rightArm: string
  leftGripper: string
  rightGripper: string
}

export const EMPTY_MOTOR_TOPICS: MotorTopics = {
  leftArm: '',
  rightArm: '',
  leftGripper: '',
  rightGripper: '',
}

export function readMotorTopics(): MotorTopics {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return EMPTY_MOTOR_TOPICS
    const parsed = JSON.parse(raw) as Partial<MotorTopics>
    return {
      leftArm: typeof parsed.leftArm === 'string' ? parsed.leftArm : '',
      rightArm: typeof parsed.rightArm === 'string' ? parsed.rightArm : '',
      leftGripper: typeof parsed.leftGripper === 'string' ? parsed.leftGripper : '',
      rightGripper: typeof parsed.rightGripper === 'string' ? parsed.rightGripper : '',
    }
  } catch {
    return EMPTY_MOTOR_TOPICS
  }
}

export function saveMotorTopics(topics: MotorTopics): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(topics))
  } catch {
    /* 读不到 localStorage 时只在本次会话生效 */
  }
}
