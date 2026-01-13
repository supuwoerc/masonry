import type { PlaceholderRenderer } from '../types'

export interface PlaceholderOptions {
  backgroundColor?: string
  borderColor?: string
  borderWidth?: number
  gradient?: boolean
}

interface AnimationState {
  renderAt: number
  content: number
  bitmap: ImageBitmap
}

export class DefaultPlaceholderRenderer implements PlaceholderRenderer {
  #options: Required<PlaceholderOptions>

  #cache = new Map<string, AnimationState>()

  constructor(options: PlaceholderOptions = {}) {
    this.#options = {
      backgroundColor: '#f5f5f5',
      borderColor: '#d0d0d0',
      borderWidth: 1,
      gradient: true,
      ...options,
    }
  }

  // TODO:完善绘制
  async render(width: number, height: number, id: string): Promise<ImageBitmap> {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    this.#drawPlaceholder(ctx, width, height, this.#cache.get(id)?.content ?? 1)
    const bitmap = await createImageBitmap(canvas)
    if (!this.#cache.has(id)) {
      this.#cache.set(id, {
        renderAt: Date.now(),
        content: 1,
        bitmap,
      })
    } else {
      const current = this.#cache.get(id)!
      if (Date.now() - current.renderAt < 500) {
        return current.bitmap
      }
      const next = current.content > 99 ? 1 : current.content + 1
      this.#cache.set(id, {
        renderAt: Date.now(),
        content: next,
        bitmap,
      })
    }
    return bitmap
  }

  dispose() {
    this.#cache.clear()
  }

  #drawPlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number, content: number) {
    // 原有背景绘制代码保持不变
    if (this.#options.gradient) {
      const gradient = ctx.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, this.lightenColor(this.#options.backgroundColor, 0.1))
      gradient.addColorStop(1, this.darkenColor(this.#options.backgroundColor, 0.1))
      ctx.fillStyle = gradient
    } else {
      ctx.fillStyle = this.#options.backgroundColor
    }
    ctx.fillRect(0, 0, width, height)

    // 原有边框绘制代码保持不变
    ctx.strokeStyle = this.#options.borderColor
    ctx.lineWidth = this.#options.borderWidth
    ctx.strokeRect(
      this.#options.borderWidth / 2,
      this.#options.borderWidth / 2,
      width - this.#options.borderWidth,
      height - this.#options.borderWidth,
    )

    // 新增文字绘制代码
    ctx.fillStyle = 'red' // 设置文字颜色
    ctx.font = '14px sans-serif' // 设置字体大小和字体族
    ctx.textAlign = 'center' // 水平居中
    ctx.textBaseline = 'middle' // 垂直居中

    // 计算中心点坐标
    const centerX = width / 2
    const centerY = height / 2

    // 绘制文字（使用传入的 content 参数）
    ctx.fillText(`${content}`, centerX, centerY)
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
