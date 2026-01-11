import type { PlaceholderRenderer } from '../types'

export interface PlaceholderOptions {
  backgroundColor?: string
  borderColor?: string
  borderWidth?: number
  gradient?: boolean
}

export class DefaultPlaceholderRenderer implements PlaceholderRenderer {
  #options: Required<PlaceholderOptions>

  constructor(options: PlaceholderOptions = {}) {
    this.#options = {
      backgroundColor: '#f5f5f5',
      borderColor: '#d0d0d0',
      borderWidth: 1,
      gradient: true,
      ...options,
    }
  }

  render(width: number, height: number): Promise<ImageBitmap> {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    this.#drawPlaceholder(ctx, width, height)
    return createImageBitmap(canvas)
  }

  #drawPlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (this.#options.gradient) {
      const gradient = ctx.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, this.lightenColor(this.#options.backgroundColor, 0.1))
      gradient.addColorStop(1, this.darkenColor(this.#options.backgroundColor, 0.1))
      ctx.fillStyle = gradient
    } else {
      ctx.fillStyle = this.#options.backgroundColor
    }
    ctx.fillRect(0, 0, width, height)

    ctx.strokeStyle = this.#options.borderColor
    ctx.lineWidth = this.#options.borderWidth
    ctx.strokeRect(
      this.#options.borderWidth / 2,
      this.#options.borderWidth / 2,
      width - this.#options.borderWidth,
      height - this.#options.borderWidth,
    )
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
