import type { GradientBackground } from '../core/types'
import { isString } from 'lodash-es'

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
