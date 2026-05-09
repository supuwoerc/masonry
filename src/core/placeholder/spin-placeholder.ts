import type { GradientBackground, PlaceholderRenderer } from '../types'
import { createBackgroundStyle } from '@/helper/background'

/**
 * 占位符动画状态
 * Placeholder animation state
 */
interface AnimationState {
  /** 动画开始时间 | Animation start time */
  startTime: number
  /** 当前位图快照 | Current bitmap snapshot */
  bitmap: ImageBitmap
  /** 离屏绘制用 Canvas | Offscreen drawing canvas */
  canvas: HTMLCanvasElement
  /** 设备像素比 | Device pixel ratio */
  dpr: number
}

/**
 * 占位符渲染器选项
 * Placeholder renderer options
 */
export interface PlaceholderOptions {
  /** 背景颜色或渐变配置 | Background color or gradient configuration */
  backgroundColor?: string | GradientBackground
}

/**
 * 旋转加载动画占位符渲染器
 * Spinning loader animation placeholder renderer
 *
 * 在图片加载过程中显示带有旋转圆点动画的占位图。
 * 每个占位符独立管理动画状态和 Canvas 缓存。
 *
 * Displays a placeholder with spinning dots animation during image loading.
 * Each placeholder independently manages animation state and canvas cache.
 */
export class SpinPlaceholderRenderer implements PlaceholderRenderer {
  #cache = new Map<string, AnimationState>()

  #options: PlaceholderOptions = { backgroundColor: '#f2f2f2' }

  /**
   * 创建旋转占位符渲染器实例
   * Create spinning placeholder renderer instance
   * @param options - 渲染器选项 | Renderer options
   */
  constructor(options: PlaceholderOptions = {}) {
    this.#options = {
      backgroundColor: '#f2f2f2',
      ...options,
    }
  }

  /**
   * 释放所有缓存资源
   * Dispose all cached resources
   */
  dispose() {
    this.#cache.forEach((state) => {
      state.canvas.width = 0
      state.canvas.height = 0
      state.bitmap.close()
    })
    this.#cache.clear()
  }

  /**
   * 移除指定 ID 的占位符并释放资源
   * Remove placeholder by ID and release resources
   * @param id - 占位符唯一标识 | Placeholder unique identifier
   */
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

  /**
   * 渲染一帧占位符动画并返回位图
   * Render one frame of placeholder animation and return bitmap
   * @param width - 占位符宽度（CSS 像素）| Placeholder width (CSS pixels)
   * @param height - 占位符高度（CSS 像素）| Placeholder height (CSS pixels)
   * @param id - 唯一标识（用于缓存动画状态）| Unique ID (for caching animation state)
   * @returns 当前帧的 ImageBitmap | Current frame ImageBitmap
   */
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
      canvas.width = physWidth
      canvas.height = physHeight
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`

      const ctx = canvas.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'

      state = {
        canvas,
        dpr,
        startTime: now,
        bitmap: await createImageBitmap(canvas),
      }
      this.#cache.set(id, state)
    }

    const ctx = state.canvas.getContext('2d')!
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0)
    ctx.imageSmoothingEnabled = false

    ctx.clearRect(0, 0, cssWidth, cssHeight)

    const bgStyle = createBackgroundStyle(
      ctx,
      cssWidth,
      cssHeight,
      this.#options.backgroundColor || '#f2f2f2',
    )
    ctx.fillStyle = bgStyle
    ctx.fillRect(0, 0, Math.ceil(cssWidth), Math.ceil(cssHeight))

    const elapsed = now - state.startTime
    const angle = ((elapsed / 1200) * 360) % 360
    this.#drawLoader(ctx, cssWidth, cssHeight, angle)

    state.bitmap.close()
    state.bitmap = await createImageBitmap(state.canvas)

    return state.bitmap
  }
}
