import type { GradientBackground, PlaceholderRenderer } from '../types'
import { createBackgroundStyle } from '@/helper/background'

/**
 * 呼吸动画占位符状态
 * Breathing animation placeholder state
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
 * 呼吸占位符选项
 * Breathing placeholder options
 */
interface BreathingOptions {
  /**
   * 底色（支持纯色或渐变）
   * Background color (supports solid color or gradient)
   * @default '#e0e0e0'
   */
  backgroundColor?: string | GradientBackground
  /**
   * 呼吸叠加色
   * Breathing overlay color
   * @default 'rgba(255, 255, 255, 0.6)'
   */
  highlightColor?: string
  /**
   * 单次呼吸周期时间（ms）
   * Duration of one breathing cycle in ms
   * @default 1500
   */
  duration?: number
  /**
   * 圆角半径（px）
   * Border radius in px
   * @default 0
   */
  radius?: number
}

/**
 * 呼吸渐变占位符渲染器
 * Breathing gradient placeholder renderer
 *
 * 在图片加载过程中显示带有呼吸渐变动画的占位图。
 * 整体明暗随正弦曲线周期性变化，模拟呼吸节奏。
 *
 * Displays a placeholder with breathing gradient animation during image loading.
 * The overall brightness oscillates following a sine curve, simulating a breathing rhythm.
 *
 * @example
 * ```ts
 * const breathing = new BreathingPlaceholderRenderer({
 *   backgroundColor: '#e0e0e0',
 *   highlightColor: 'rgba(255, 255, 255, 0.6)',
 *   duration: 1500,
 *   radius: 8,
 * })
 * ```
 */
export class BreathingPlaceholderRenderer implements PlaceholderRenderer {
  #cache = new Map<string, AnimationState>()

  #options: Required<BreathingOptions>

  /**
   * 创建呼吸占位符渲染器实例
   * Create breathing placeholder renderer instance
   * @param options - 渲染器选项 | Renderer options
   */
  constructor(options: BreathingOptions = {}) {
    this.#options = {
      backgroundColor: '#e0e0e0',
      highlightColor: 'rgba(255, 255, 255, 0.6)',
      duration: 1500,
      radius: 0,
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

  #drawBreathing(ctx: CanvasRenderingContext2D, width: number, height: number, progress: number) {
    const alpha = 0.3 + 0.3 * Math.sin(progress * Math.PI * 2)
    ctx.fillStyle = this.#options.highlightColor.replace(/[\d.]+\)$/, `${alpha})`)
    ctx.fillRect(0, 0, width, height)
  }

  /**
   * 渲染一帧呼吸动画并返回位图
   * Render one frame of breathing animation and return bitmap
   * @param width - 占位符宽度（CSS 像素）| Placeholder width (CSS pixels)
   * @param height - 占位符高度（CSS 像素）| Placeholder height (CSS pixels)
   * @param id - 唯一标识（用于缓存动画状态）| Unique ID (for caching animation state)
   * @returns 当前帧的 ImageBitmap | Current frame ImageBitmap
   */
  async render(width: number, height: number, id: string): Promise<ImageBitmap> {
    const now = performance.now()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cssWidth = width
    const cssHeight = height
    const physWidth = Math.round(width * dpr)
    const physHeight = Math.round(height * dpr)

    let state = this.#cache.get(id)

    if (!state) {
      const canvas = document.createElement('canvas')
      canvas.width = physWidth
      canvas.height = physHeight
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`

      const ctx = canvas.getContext('2d')!
      ctx.scale(dpr, dpr)

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

    ctx.clearRect(0, 0, cssWidth, cssHeight)

    ctx.save()
    if (this.#options.radius > 0) {
      ctx.beginPath()
      ctx.roundRect(0, 0, cssWidth, cssHeight, this.#options.radius)
      ctx.clip()
    }

    const bgStyle = createBackgroundStyle(ctx, cssWidth, cssHeight, this.#options.backgroundColor)
    ctx.fillStyle = bgStyle
    ctx.fillRect(0, 0, cssWidth, cssHeight)

    const elapsed = now - state.startTime
    const progress = (elapsed % this.#options.duration) / this.#options.duration
    this.#drawBreathing(ctx, cssWidth, cssHeight, progress)

    ctx.restore()

    state.bitmap.close()
    state.bitmap = await createImageBitmap(state.canvas)

    return state.bitmap
  }
}
