import { describe, expect, it } from 'vitest'
import { bridgeCompat, SUPPORTED_BRIDGE_VERSION } from './bridgeCompat'

describe('bridgeCompat', () => {
  it('同一版（含补丁号不同）算对得上', () => {
    expect(bridgeCompat(SUPPORTED_BRIDGE_VERSION)).toBe('ok')
    expect(bridgeCompat(`${SUPPORTED_BRIDGE_VERSION}.0`)).toBe('ok')
    expect(bridgeCompat(`${SUPPORTED_BRIDGE_VERSION}.7`)).toBe('ok')
    // 桥自己发的是裸的 X.Y.Z，但容一个 v 前缀不吃亏
    expect(bridgeCompat(`v${SUPPORTED_BRIDGE_VERSION}.0`)).toBe('ok')
  })

  it('minor 或 major 变了就是不一致', () => {
    expect(bridgeCompat('0.2.0')).toBe('mismatch')
    expect(bridgeCompat('1.0.0')).toBe('mismatch')
  })

  it('读不出来就说不知道，而不是报警', () => {
    expect(bridgeCompat('')).toBe('unknown')
    expect(bridgeCompat('   ')).toBe('unknown')
    expect(bridgeCompat('unknown')).toBe('unknown')
    expect(bridgeCompat('0')).toBe('unknown')
  })
})
