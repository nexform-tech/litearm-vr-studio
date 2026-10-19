import { describe, it, expect, beforeEach } from 'vitest'
import i18n from '../index'

// VR-only 版本只保留 common / nav / vr 三个命名空间。
describe('i18n Internationalization', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('initializes with Chinese (zh) by default', () => {
    expect(i18n.language.startsWith('zh')).toBe(true)
    expect(i18n.t('nav:vr')).toBe('VR')
    expect(i18n.t('nav:vrTitle')).toBe('VR 遥操控制台')
    expect(i18n.t('common:connected')).toBe('已连接')
    expect(i18n.t('common:enable')).toBe('使能')
    expect(i18n.t('vr:link.title')).toBe('VR 链路')
    expect(i18n.t('vr:control.title')).toBe('遥操控制')
    expect(i18n.t('vr:load.title')).toBe('电机负载')
    expect(i18n.t('vr:manifest.title')).toBe('臂映射')
  })

  it('switches to English (en) and returns corresponding keys', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.language).toBe('en')
    expect(i18n.t('nav:vr')).toBe('VR')
    expect(i18n.t('nav:vrTitle')).toBe('VR Teleop Console')
    expect(i18n.t('common:connected')).toBe('Connected')
    expect(i18n.t('common:enable')).toBe('Enable')
    expect(i18n.t('vr:link.title')).toBe('VR Link')
    expect(i18n.t('vr:control.title')).toBe('Teleop Control')
    expect(i18n.t('vr:load.title')).toBe('Motor Load')
    expect(i18n.t('vr:manifest.title')).toBe('Arm mapping')
  })

  it('updates document.documentElement.lang on language change', async () => {
    await i18n.changeLanguage('en')
    expect(document.documentElement.lang).toBe('en')
    await i18n.changeLanguage('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})
