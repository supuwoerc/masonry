import type { GradientBackground } from '../core/types'
import { isString } from 'lodash-es'

/**
 * 根据背景配置创建 Canvas 填充样式
 * Create Canvas fill style based on background configuration
 *
 * 支持纯色字符串和渐变（线性/径向）两种模式。
 * Supports solid color strings and gradient (linear/radial) modes.
 *
 * @param ctx - Canvas 2D 渲染上下文 | Canvas 2D rendering context
 * @param width - 画布宽度 | Canvas width
 * @param height - 画布高度 | Canvas height
 * @param bg - 背景配置（颜色字符串或渐变对象）| Background config (color string or gradient object)
 * @returns Canvas 填充样式（字符串或 CanvasGradient）| Canvas fill style (string or CanvasGradient)
 */
export function createBackgroundStyle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  bg: string | GradientBackground,
): CanvasFillStrokeStyles['fillStyle'] {
  if (isString(bg)) {
    return bg
  }

  let gradient: CanvasGradient
  if (bg.type === 'linear') {
    const [x0, y0] = bg.linear?.start || [0, 0]
    const [x1, y1] = bg.linear?.end || [width, 0]
    gradient = ctx.createLinearGradient(x0, y0, x1, y1)
  } else {
    const [x0, y0] = bg.radial?.start || [width / 2, height / 2]
    const [x1, y1] = bg.radial?.end || [x0, y0]
    gradient = ctx.createRadialGradient(
      x0,
      y0,
      bg.radial?.r0 || 0,
      x1,
      y1,
      bg.radial?.r1 || Math.max(width, height),
    )
  }

  bg.stops.forEach((stop) => {
    gradient.addColorStop(stop.offset, stop.color)
  })

  return gradient
}
