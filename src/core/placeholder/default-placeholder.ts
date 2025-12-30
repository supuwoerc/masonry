import type { PlaceholderOptions, PlaceholderRenderer } from '../types'

export class DefaultPlaceholderRenderer implements PlaceholderRenderer {
  private options: Required<PlaceholderOptions>
  private cache: Map<string, CanvasImageSource> = new Map()

  constructor(options: PlaceholderOptions = {}) {
    this.options = {
      backgroundColor: '#f5f5f5',
      borderColor: '#d0d0d0',
      borderWidth: 1,
      showIndex: false,
      gradient: true,
      ...options,
    }
  }

  render(width: number, height: number, index: number): CanvasImageSource {
    const cacheKey = `${width}x${height}-${index}-${JSON.stringify(this.options)}`

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!

    // 绘制逻辑...
    this.drawPlaceholder(ctx, width, height, index)

    this.cache.set(cacheKey, canvas)
    return canvas
  }

  private drawPlaceholder(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    index: number,
  ) {
    // 绘制背景
    if (this.options.gradient) {
      const gradient = ctx.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, this.lightenColor(this.options.backgroundColor, 0.1))
      gradient.addColorStop(1, this.darkenColor(this.options.backgroundColor, 0.1))
      ctx.fillStyle = gradient
    } else {
      ctx.fillStyle = this.options.backgroundColor
    }
    ctx.fillRect(0, 0, width, height)

    // 绘制边框
    ctx.strokeStyle = this.options.borderColor
    ctx.lineWidth = this.options.borderWidth
    ctx.strokeRect(
      this.options.borderWidth / 2,
      this.options.borderWidth / 2,
      width - this.options.borderWidth,
      height - this.options.borderWidth,
    )

    // 绘制索引
    if (this.options.showIndex) {
      ctx.fillStyle = '#888'
      ctx.font = `${Math.min(width, height) / 5}px Arial`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(index.toString(), width / 2, height / 2)
    }
  }

  dispose() {
    this.cache.clear()
  }

  private lightenColor(color: string, _amount: number): string {
    // 颜色处理逻辑
    return color
  }

  private darkenColor(color: string, _amount: number): string {
    // 颜色处理逻辑
    return color
  }
}
