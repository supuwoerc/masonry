import Stats from 'stats.js'

const panelMap = {
  fps: 0,
  ms: 1,
  mb: 2,
  custom: 3,
} as const

export class StatsMonitor {
  #stats: Stats
  #enabled = true
  #animationId: number | null = null

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

  start() {
    if (!this.#animationId) {
      this.#stats.begin()
      this.loop()
    }
  }

  stop() {
    if (this.#animationId) {
      cancelAnimationFrame(this.#animationId)
      this.#animationId = null
      this.#stats.end()
    }
  }

  enable() {
    this.#enabled = true
    this.#stats.dom.style.display = 'block'
  }

  disable(): void {
    this.#enabled = false
    this.#stats.dom.style.display = 'none'
  }

  toggle(): void {
    this.#enabled = !this.#enabled
    this.#stats.dom.style.display = this.#enabled ? 'block' : 'none'
  }

  customizeStyle(style: Partial<CSSStyleDeclaration>): void {
    Object.assign(this.#stats.dom.style, style)
  }

  private loop(): void {
    this.#stats.update()
    this.#animationId = requestAnimationFrame(() => this.loop())
  }
}
