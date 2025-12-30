export function setupCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const dpr = window.devicePixelRatio || 1
  const displayWidth = canvas.clientWidth
  const displayHeight = canvas.clientHeight
  canvas.width = displayWidth * dpr
  canvas.height = displayHeight * dpr
  canvas.style.width = `${displayWidth}px`
  canvas.style.height = `${displayHeight}px`
  ctx.scale(dpr, dpr)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
}
