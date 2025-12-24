import { isFunction } from 'lodash-es'

/**
 * FPSCounter 用于跟踪和计算帧率
 * FPSCounter for tracking and calculating frame rate
 */
export class FPSCounter {
  /** 最后记录时间 / Last recorded timestamp */
  #lastTime: number = performance.now()

  /** 帧数计数器 / Frame counter */
  #frameCount: number = 0

  /** 当前帧率值 / Current FPS value */
  #fps: number = 0

  /** 动画帧ID / Animation frame ID */
  #animationId: number | null = null

  /** 是否启用回调 / Whether callback is enabled */
  #isEnabled: boolean = true

  /**
   * FPS回调函数
   * @param fps - 当前帧率值 / Current FPS value
   *
   * FPS callback function
   * @param fps - Current frames per second value
   */

  #callback?: (fps: number) => void = (fps) => {
    // eslint-disable-next-line no-console
    console.log(`FPS: ${fps}`)
  }

  /**
   * 构造函数
   * @param callback - FPS回调函数/FPS callback function
   * @param start - 是否立即启动/Whether to start immediately
   */
  constructor(callback?: (fps: number) => void, start = true) {
    if (isFunction(callback)) {
      this.#callback = callback
    }
    if (start) {
      this.start()
    }
  }

  /**
   * 启动帧率计数器
   * Starts the FPS counter
   */
  start(): void {
    if (!this.#animationId) {
      this.#tick()
    }
  }

  /**
   * 停止帧率计数器
   * Stops the FPS counter
   */
  stop(): void {
    if (this.#animationId) {
      cancelAnimationFrame(this.#animationId)
      this.#animationId = null
    }
  }

  /**
   * 启用回调通知
   * Enables callback notifications
   */
  enable(): void {
    this.#isEnabled = true
  }

  /**
   * 禁用回调通知
   * Disables callback notifications
   */
  disable(): void {
    this.#isEnabled = false
  }

  /**
   * 切换状态
   * Toggle isEnabled
   */
  toggle(): void {
    this.#isEnabled = !this.#isEnabled
  }

  /**
   * 获取当前帧率值
   * @returns 当前帧率/Current FPS value
   */
  getFPS(): number {
    return this.#fps
  }

  /**
   * 重置计数器
   * Resets all counters
   */
  reset(): void {
    this.#frameCount = 0
    this.#lastTime = performance.now()
    this.#fps = 0
  }

  /**
   * 内部计时器函数
   * Internal tick function for FPS calculation
   */
  #tick(): void {
    const now = performance.now()
    const delta = now - this.#lastTime
    this.#frameCount++
    if (delta >= 1000) {
      this.#fps = Math.round((this.#frameCount * 1000) / delta)
      if (this.#isEnabled && this.#callback) {
        this.#callback(this.#fps)
      }
      this.#frameCount = 0
      this.#lastTime = now
    }
    this.#animationId = requestAnimationFrame(() => this.#tick())
  }
}
