import { chunk, flatten, isFunction } from 'lodash-es'

export interface MasonryItemStyle {
  width: number
  height: number
  radius?: number
  gap?: number
}

export interface MasonryItem {
  source: CanvasImageSource
  x: number
  y: number
}

export interface MasonryOptions {
  canvas: HTMLCanvasElement
  items: Array<CanvasImageSource>
  style: MasonryItemStyle
  onReady?: (instance: Masonry) => void
  onError?: (err: unknown) => void
}

export default class Masonry {
  #canvas!: HTMLCanvasElement

  #canvasContext!: CanvasRenderingContext2D

  #supportsRoundRect = false

  #moveable = false

  #scrollable = true

  #disabled = {
    horizontal: false,
    vertical: false,
  }

  #style: MasonryItemStyle = {
    width: 200,
    height: 300,
  }

  #gridItems: Array<Array<MasonryItem>> = []

  #canvasWidth = 0

  #canvasHeight = 0

  #resizeObserver = new ResizeObserver(() => this.resize())

  onReady: ((instance: Masonry) => void) | null = null

  onError = (err: unknown) => console.error(err)

  constructor(options: MasonryOptions) {
    this.#initConfig(options)
    this.#initializeGrid(options)
  }

  get columnCapacity() {
    return Math.ceil(this.#canvasWidth / this.blockWidth)
  }

  get columnSize() {
    return Math.floor(this.#canvasWidth / this.blockWidth)
  }

  get rowCapacity() {
    return Math.ceil(this.#canvasHeight / this.blockHeight)
  }

  get rowSize() {
    return Math.floor(this.#canvasHeight / this.blockHeight)
  }

  get blockWidth() {
    return this.#style.width + (this.#style.gap ?? 0)
  }

  get blockHeight() {
    return this.#style.height + (this.#style.gap ?? 0)
  }

  get gap() {
    return this.#style.gap ?? 0
  }

  get radius() {
    return this.#style.radius ?? 0
  }

  #initConfig(options: MasonryOptions) {
    if (options.items.length <= 0) {
      throw new Error('items is required')
    }
    if (options.style.width <= 0) {
      throw new Error('item width must > 0')
    }
    if (options.style.height <= 0) {
      throw new Error('item height must > 0')
    }
    if ((options.style?.gap ?? 0) < 0) {
      throw new Error('item gap must >= 0')
    }
    if ((options.style?.radius ?? 0) < 0) {
      throw new Error('item radius must >= 0')
    }
    if (!options.canvas.getContext('2d')) {
      throw new Error('2d context of canvas not supported or available')
    }
    if (options.onError && !isFunction(options.onError)) {
      throw new Error('onError is not a valid callback function')
    }
    this.#canvas = options.canvas
    this.#canvasContext = options.canvas.getContext('2d')!
    this.#supportsRoundRect = Boolean(
      this.#canvasContext && this.#canvasContext.roundRect,
    )
    this.#style = options.style
    this.#setupCanvas()
    if (options.onError && isFunction(options.onError)) {
      this.onError = options.onError
    }
    if (options.onReady && isFunction(options.onReady)) {
      this.onReady = options.onReady
    }
  }

  #setupCanvas() {
    const dpr = window.devicePixelRatio || 1
    const displayWidth = this.#canvas.clientWidth
    const displayHeight = this.#canvas.clientHeight
    this.#canvas.width = displayWidth * dpr
    this.#canvas.height = displayHeight * dpr
    this.#canvas.style.width = `${displayWidth}px`
    this.#canvas.style.height = `${displayHeight}px`
    this.#canvasWidth = displayWidth
    this.#canvasHeight = displayHeight
    this.#canvasContext.scale(dpr, dpr)
    this.#canvasContext.imageSmoothingEnabled = true
    this.#canvasContext.imageSmoothingQuality = 'high'
  }

  #initializeGrid(options: MasonryOptions) {
    this.#gridItems = chunk(
      this.#calculateItemPositions(options.items),
      this.columnCapacity,
    )
    this.#render(this.#gridItems)
    this.#bindEvent()
    this.onReady?.(this)
  }

  enable(horizontal = false, vertical = false) {
    this.#disabled.horizontal = horizontal
    this.#disabled.vertical = vertical
  }

  disable(horizontal = true, vertical = true) {
    this.#disabled.horizontal = horizontal
    this.#disabled.vertical = vertical
  }

  clear() {
    this.#canvasContext?.clearRect(0, 0, this.#canvasWidth, this.#canvasHeight)
  }

  destroy() {
    this.#unbindEvent()
    this.clear()
  }

  #isOutOfBounds(x: number, y: number) {
    const overflowX = x < -this.#style.width || x > this.#canvasWidth
    const overflowY = y < -this.#style.height || y > this.#canvasHeight
    return overflowX || overflowY
  }

  #calculateItemPositions(items: Array<CanvasImageSource>) {
    const result: Array<MasonryItem> = []
    const count = this.columnCapacity * this.rowCapacity
    for (let index = 0; index < count; index++) {
      const column = index % this.columnCapacity
      const row = Math.floor(index / this.columnCapacity)
      const x = column * this.blockWidth
      const y = row * this.blockHeight
      const source = items[index % items.length]
      result.push({ source, x, y })
    }
    return result
  }

  #mousedown() {
    this.#moveable = true
  }

  #mouseup() {
    this.#moveable = false
  }

  #mouseleave() {
    this.#moveable = false
  }

  #mousemove(e: MouseEvent) {
    if (this.#moveable) {
      this.#updateGridPosition(e.movementX, e.movementY)
    }
  }

  #wheel(e: WheelEvent) {
    e.preventDefault()
    if (this.#disabled.vertical || !this.#scrollable) {
      return
    }
    this.#updateGridPosition(0, -e.deltaY)
  }

  get events() {
    return {
      mousedown: this.#mousedown.bind(this),
      mouseup: this.#mouseup.bind(this),
      mouseleave: this.#mouseleave.bind(this),
      mousemove: this.#mousemove.bind(this),
      wheel: this.#wheel.bind(this),
    }
  }

  #bindEvent() {
    this.#canvas.addEventListener('mousedown', this.events.mousedown)
    this.#canvas.addEventListener('mouseup', this.events.mouseup)
    this.#canvas.addEventListener('mouseleave', this.events.mouseleave)
    this.#canvas.addEventListener('mousemove', this.events.mousemove)
    this.#canvas.addEventListener('wheel', this.events.wheel)
    this.#resizeObserver.observe(this.#canvas)
  }

  #unbindEvent() {
    this.#canvas.removeEventListener('mousedown', this.events.mousedown)
    this.#canvas.removeEventListener('mouseup', this.events.mouseup)
    this.#canvas.removeEventListener('mouseleave', this.events.mouseleave)
    this.#canvas.removeEventListener('mousemove', this.events.mousemove)
    this.#canvas.removeEventListener('wheel', this.events.wheel)
    this.#resizeObserver.disconnect()
  }

  #updateGridPosition(x: number, y: number) {
    if (this.#disabled.horizontal && this.#disabled.vertical) {
      return
    }
    this.clear()
    flatten(this.#gridItems).forEach((item) => {
      !this.#disabled.horizontal && (item.x += x)
      !this.#disabled.vertical && (item.y += y)
    })
    const afterImages: Array<Array<MasonryItem>> = []
    this.#gridItems.forEach((row) => {
      if (row.length === 0) {
        return
      }
      const afterRow = this.#appendHorizontalItems(row, x)
      if (afterRow.length > 0) {
        afterImages.push(afterRow)
      }
    })
    if (y !== 0) {
      this.#appendVerticalItems(afterImages, y)
    }
    this.#gridItems = afterImages
    this.#render(this.#gridItems)
  }

  #appendHorizontalItems(row: MasonryItem[], x: number): Array<MasonryItem> {
    if (row.length === 0) {
      return row
    }
    const afterRow: MasonryItem[] = []
    const leftmost = row[0]
    const rightmost = row[row.length - 1]
    if (x > 0 && leftmost.x > this.gap) {
      afterRow.push({
        source: rightmost.source,
        x: leftmost.x - this.blockWidth,
        y: leftmost.y,
      })
    }
    row.forEach((element) => {
      if (!this.#isOutOfBounds(element.x, element.y)) {
        afterRow.push(element)
      }
    })
    if (x < 0 && rightmost.x < this.#canvasWidth - this.blockWidth) {
      afterRow.push({
        source: leftmost.source,
        x: rightmost.x + this.blockWidth,
        y: rightmost.y,
      })
    }
    return afterRow
  }

  #appendVerticalItems(images: Array<Array<MasonryItem>>, y: number) {
    if (images.length === 0) {
      return
    }
    const firstRow = images[0]
    const firstRowY = firstRow[0].y
    const lastRow = images[images.length - 1]
    const lastRowY = lastRow[0].y
    if (y > 0 && firstRowY > this.gap) {
      const patch = this.#columnPatch(lastRow, firstRowY - this.blockHeight)
      images.unshift(patch)
    }
    if (y < 0 && lastRowY < this.#canvasHeight - this.blockHeight) {
      const patch = this.#columnPatch(firstRow, lastRowY + this.blockHeight)
      images.push(patch)
    }
  }

  #columnPatch(row: MasonryItem[], newY: number): MasonryItem[] {
    return row.map((template) => ({
      source: template.source,
      x: template.x,
      y: newY,
    }))
  }

  resize() {
    // FIXME:resize
    this.#setupCanvas()
    if (this.#gridItems.length > 0) {
      this.#gridItems = chunk(flatten(this.#gridItems), this.columnCapacity)
      this.clear()
      this.#render(this.#gridItems)
    }
  }

  #roundedDraw(
    source: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
  ) {
    if (this.#canvasContext) {
      const ctx = this.#canvasContext
      ctx.save()
      ctx.beginPath()
      if (this.#supportsRoundRect) {
        ctx.roundRect(x, y, w, h, radius)
      } else {
        ctx.moveTo(x + radius, y)
        ctx.lineTo(x + w - radius, y)
        ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
        ctx.lineTo(x + w, y + h - radius)
        ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
        ctx.lineTo(x + radius, y + h)
        ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
        ctx.lineTo(x, y + radius)
        ctx.quadraticCurveTo(x, y, x + radius, y)
        ctx.closePath()
      }

      ctx.clip()
      ctx.drawImage(source, x, y, w, h)
      ctx.restore()
    }
  }

  #render(images: Array<Array<MasonryItem>>) {
    if (images.length > 0) {
      const w = this.#style.width
      const h = this.#style.height
      const list = flatten(images)
      const radius = this.radius
      for (let index = 0; index < list.length; index++) {
        const { source, x, y } = list[index]
        if (radius > 0) {
          this.#roundedDraw(source, x, y, w, h, radius)
        } else {
          this.#canvasContext?.drawImage(source, x, y, w, h)
        }
      }
    }
  }
}
