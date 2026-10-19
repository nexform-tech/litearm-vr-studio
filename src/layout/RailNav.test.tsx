/**
 * 侧栏（RailNav）的可访问名 —— 只管"读屏会念出什么"。
 *
 * VR-only 版本只有这一条导航项，这里也顺便钉住已删掉的页面不会回来。
 */
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { RailNav } from './RailNav'

function renderRail() {
  return render(
    <MemoryRouter>
      <RailNav />
    </MemoryRouter>,
  )
}

describe('RailNav', () => {
  it('keeps the logo out of the accessible name', () => {
    const { container } = renderRail()
    const logo = container.querySelector('img')
    expect(logo).not.toBeNull()
    // 装饰性图标：alt 为空且不进可访问树，读屏不会在中文界面里念出一句英文。
    expect(logo!.getAttribute('alt')).toBe('')
    expect(logo!.getAttribute('aria-hidden')).toBe('true')
  })

  it('only announces the VR page (control/logs/settings are gone)', () => {
    const { getByRole, queryByRole } = renderRail()
    expect(getByRole('link', { name: 'VR' })).toBeTruthy()
    expect(queryByRole('link', { name: 'Control' })).toBeNull()
    expect(queryByRole('link', { name: 'Logs' })).toBeNull()
    expect(queryByRole('link', { name: 'Settings' })).toBeNull()
  })
})
