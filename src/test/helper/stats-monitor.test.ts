import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StatsMonitor } from '@/helper/stats-monitor'

vi.mock('stats.js', () => {
  const Stats = vi.fn(function (this: any) {
    this.showPanel = vi.fn()
    this.dom = document.createElement('div')
    this.begin = vi.fn()
    this.end = vi.fn()
    this.update = vi.fn()
  })
  return { default: Stats }
})

describe('class StatsMonitor', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((_) => {
      return 1 as unknown as number
    })
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should mount stats dom to the given container', () => {
    new StatsMonitor('fps', container)

    expect(container.children.length).toBe(1)
  })

  it('should start monitoring immediately by default', () => {
    new StatsMonitor('fps', container)

    expect(requestAnimationFrame).toHaveBeenCalled()
  })

  it('should not start monitoring when start is false', () => {
    new StatsMonitor('fps', container, false)

    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('should stop monitoring loop', () => {
    const monitor = new StatsMonitor('fps', container)
    monitor.stop()

    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it('should not error when stop is called without start', () => {
    const monitor = new StatsMonitor('fps', container, false)

    expect(() => monitor.stop()).not.toThrow()
  })

  it('should hide panel on disable', () => {
    const monitor = new StatsMonitor('fps', container)
    monitor.disable()

    const statsDom = container.children[0] as HTMLElement
    expect(statsDom.style.display).toBe('none')
  })

  it('should show panel on enable', () => {
    const monitor = new StatsMonitor('fps', container)
    monitor.disable()
    monitor.enable()

    const statsDom = container.children[0] as HTMLElement
    expect(statsDom.style.display).toBe('block')
  })

  it('should toggle panel visibility', () => {
    const monitor = new StatsMonitor('fps', container)
    monitor.toggle()

    const statsDom = container.children[0] as HTMLElement
    expect(statsDom.style.display).toBe('none')

    monitor.toggle()
    expect(statsDom.style.display).toBe('block')
  })

  it('should apply custom styles via customizeStyle', () => {
    const monitor = new StatsMonitor('fps', container)
    monitor.customizeStyle({ position: 'absolute', top: '10px' })

    const statsDom = container.children[0] as HTMLElement
    expect(statsDom.style.position).toBe('absolute')
    expect(statsDom.style.top).toBe('10px')
  })

  it('should not start again if already running', () => {
    const monitor = new StatsMonitor('fps', container)
    const callCount = (requestAnimationFrame as ReturnType<typeof vi.fn>).mock.calls.length
    monitor.start()

    expect((requestAnimationFrame as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCount)
  })
})
