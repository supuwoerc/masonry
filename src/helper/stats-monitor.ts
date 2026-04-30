import Stats from 'stats.js'

/**
 * 面板类型到 stats.js 面板索引的映射
 * Panel type to stats.js panel index mapping
 */
const panelMap = {
  fps: 0,
  ms: 1,
  mb: 2,
  custom: 3,
} as const

/**
 * 性能监控器，封装 stats.js 提供 FPS/帧时间/内存监控
 * Performance monitor wrapping stats.js for FPS/frame time/memory monitoring
 *
 * @example
 * ```ts
 * const monitor = new StatsMonitor('fps', document.body)
 * // 在不需要时停止
 * monitor.stop()
 * ```
 */
export class StatsMonitor {
  #stats: Stats
  #enabled = true
  #animationId: number | null = null

  /**
   * 创建性能监控器实例
   * Create performance monitor instance
   * @param showPanel - 显示的面板类型 | Panel type to display
   * @param dom - 挂载的 DOM 元素 | DOM element to mount to
   * @param start - 是否立即开始监控 | Whether to start monitoring immediately
   */
  constructor(
    showPanel: 'fps' | 'ms' | 'mb' | 'custom' = 'fps',
    dom = document.body,
    start = true,
  ) {
    this.#stats = new Stats()
    this.#stats.showPanel(panelMap[showPanel])
    dom.appendChild(this.#stats.dom)
    if (start) {
      this.start()
    }
  }

  /**
   * 开始监控循环
   * Start monitoring loop
   */
  start() {
    if (!this.#animationId) {
      this.#stats.begin()
      this.loop()
    }
  }

  /**
   * 停止监控循环
   * Stop monitoring loop
   */
  stop() {
    if (this.#animationId) {
      cancelAnimationFrame(this.#animationId)
      this.#animationId = null
      this.#stats.end()
    }
  }

  /**
   * 启用面板显示
   * Enable panel display
   */
  enable() {
    this.#enabled = true
    this.#stats.dom.style.display = 'block'
  }

  /**
   * 禁用面板显示
   * Disable panel display
   */
  disable(): void {
    this.#enabled = false
    this.#stats.dom.style.display = 'none'
  }

  /**
   * 切换面板显示/隐藏
   * Toggle panel visibility
   */
  toggle(): void {
    this.#enabled = !this.#enabled
    this.#stats.dom.style.display = this.#enabled ? 'block' : 'none'
  }

  /**
   * 自定义面板 DOM 样式
   * Customize panel DOM style
   * @param style - 要应用的 CSS 样式属性 | CSS style properties to apply
   */
  customizeStyle(style: Partial<CSSStyleDeclaration>): void {
    Object.assign(this.#stats.dom.style, style)
  }

  private loop(): void {
    this.#stats.update()
    this.#animationId = requestAnimationFrame(() => this.loop())
  }
}
