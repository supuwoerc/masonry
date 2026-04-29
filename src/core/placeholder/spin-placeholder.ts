import type { GradientBackground, PlaceholderRenderer } from '../types'
import { createBackgroundStyle } from '@/helper/background'

interface AnimationState {
  startTime: number
  lastFrameTime: number
  bitmap: ImageBitmap
  canvas: HTMLCanvasElement
  dpr: number
}

interface PlaceholderOptions {
  backgroundColor?: string | GradientBackground
}

export class SpinPlaceholderRenderer implements PlaceholderRenderer {
  #cache = new Map<string, AnimationState>()

  #options: PlaceholderOptions = { backgroundColor: '#f2f2f2' }

  constructor(options: PlaceholderOptions = {}) {
    this.#options = {
      backgroundColor: '#f2f2f2',
      ...options,
    }
  }

  dispose() {
    this.#cache.forEach((state) => {
      state.canvas.width = 0
      state.canvas.height = 0
      state.bitmap.close()
    })
    this.#cache.clear()
  }

  remove(id: string) {
    const state = this.#cache.get(id)
    if (state) {
      state.canvas.width = 0
      state.canvas.height = 0
      state.bitmap.close()
    }
    this.#cache.delete(id)
  }

  #calculateCanvasSize(width: number, height: number, dpr: number) {
    return {
      cssWidth: width,
      cssHeight: height,
      physWidth: Math.round(width * dpr),
      physHeight: Math.round(height * dpr),
    }
  }

  #drawLoader(ctx: CanvasRenderingContext2D, width: number, height: number, angle: number) {
    const centerX = Math.round(width / 2)
    const centerY = Math.round(height / 2)
    const dotSize = 4
    const loaderRadius = 8

    ctx.save()
    ctx.translate(centerX, centerY)
    ctx.rotate((angle * Math.PI) / 180)

    const positions = [
      { x: -loaderRadius, y: -loaderRadius },
      { x: loaderRadius, y: -loaderRadius },
      { x: loaderRadius, y: loaderRadius },
      { x: -loaderRadius, y: loaderRadius },
    ]

    positions.forEach((pos, index) => {
      const x = Math.round(pos.x)
      const y = Math.round(pos.y)

      ctx.beginPath()
      ctx.fillStyle = `hsl(225, 100%, ${75 - index * 10}%)`
      ctx.arc(x, y, dotSize, 0, Math.PI * 2)
      ctx.fill()
    })

    ctx.restore()
  }

  async render(width: number, height: number, id: string): Promise<ImageBitmap> {
    const now = performance.now()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const { cssWidth, cssHeight, physWidth, physHeight } = this.#calculateCanvasSize(
      width,
      height,
      dpr,
    )

    let state = this.#cache.get(id)

    if (!state) {
      const canvas = document.createElement('canvas')
      // 设置物理尺寸
      canvas.width = physWidth
      canvas.height = physHeight
      // 设置CSS尺寸
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`

      const ctx = canvas.getContext('2d')!
      // 应用DPI缩放
      ctx.scale(dpr, dpr)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'

      state = {
        canvas,
        dpr,
        lastFrameTime: now,
        startTime: now,
        bitmap: await createImageBitmap(canvas),
      }
      this.#cache.set(id, state)
    }

    const ctx = state.canvas.getContext('2d')!
    // 重置缩放和样式
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0)
    ctx.imageSmoothingEnabled = false

    // 清空画布（使用整数坐标）
    ctx.clearRect(0, 0, cssWidth, cssHeight)

    // 绘制背景（对齐物理像素）
    const bgStyle = createBackgroundStyle(
      ctx,
      cssWidth,
      cssHeight,
      this.#options.backgroundColor || '#f2f2f2',
    )
    ctx.fillStyle = bgStyle
    ctx.fillRect(0, 0, Math.ceil(cssWidth), Math.ceil(cssHeight))

    // 绘制旋转指示器（使用整数坐标）
    const elapsed = now - state.startTime
    const angle = ((elapsed / 1200) * 360) % 360
    this.#drawLoader(ctx, cssWidth, cssHeight, angle)

    state.bitmap.close()
    state.bitmap = await createImageBitmap(state.canvas)

    return state.bitmap
  }
}
