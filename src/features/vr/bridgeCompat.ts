/**
 * 桥版本护栏：这一版页面写的契约，对着桥的哪个版本。
 *
 * 桥的下一个版本要改 `/ws/status` 的契约（它会先动上游，再动自己）。页面这边字段一律按
 * 可选处理，所以契约变了**不会崩** —— 它只会静默地少显示几样，而那正是最难发现的一种坏法：
 * 操作员看到的是"一切正常，只是有个数字是空的"。
 *
 * 于是这里只做一件事：把"桥报的版本"和"我们对着写的版本"比一下，不一致时让页面说出来。
 * 不引 semver 依赖 —— 比两个数字不需要它。
 */

/** 这一版页面对着哪个桥版本。改动契约时必须一起改这里。 */
export const SUPPORTED_BRIDGE_VERSION = '0.1'

export type BridgeCompat =
  /** 桥没报版本（字段缺失、或空串）：无从判断，不吓人 */
  | 'unknown'
  /** major.minor 对得上：补丁号不同不算事 */
  | 'ok'
  /** 对不上：页面的字段解读可能已经过时 */
  | 'mismatch'

/**
 * 比较 major.minor。
 *
 * ⚠ 只比前两段：桥发的是裸的 `X.Y.Z`（`__version__`），补丁号变一次就报"不支持"只会
 * 让人学会无视这条提示。认不出版本格式（空串、乱码）时返回 `unknown` —— 宁可不说，
 * 也不要对着一个自己没读懂的值喊狼来了。
 */
export function bridgeCompat(version: string): BridgeCompat {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return 'unknown'
  return `${match[1]}.${match[2]}` === SUPPORTED_BRIDGE_VERSION ? 'ok' : 'mismatch'
}
