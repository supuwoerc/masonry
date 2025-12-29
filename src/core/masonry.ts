import { chunk, flatten, isFunction } from 'lodash-es'
import { Validator } from '@/helper/validator'
import { isCanvasSupported } from '@/utils/canvas'
import { configRules } from './config-rules'
import { MasonryError } from './error'
import 'path2d-polyfill'

export interface GridItemStyle {
  width: number
  height: number
  radius?: number
  gap?: number
}

export interface GridItem {
  source: CanvasImageSource
  x: number
  y: number
}

export interface ClickEvent {
  item: GridItem
  index: number
  row: number
  column: number
  event: MouseEvent
}

export interface Config {
  canvas: HTMLCanvasElement
  items: Array<CanvasImageSource>
  style: GridItemStyle
  onReady?: (instance: Masonry) => void
  onError?: (err: unknown) => void
  onClick?: (event: ClickEvent) => void
}

export class Masonry {
  #canvas!: HTMLCanvasElement

  #canvasContext!: CanvasRenderingContext2D

  #moveable = false

  #scrollable = true

  #disabled = {
    horizontal: false,
    vertical: false,
  }

  #style: GridItemStyle = {
    width: 200,
    height: 300,
  }

  #gridItems: Array<Array<GridItem>> = []

  #canvasWidth = 0

  #canvasHeight = 0

  #resizeObserver = new ResizeObserver(() => this.resize())

  #configValidator = new Validator<Config>(configRules)

  #spatialIndex: Map<string, GridItem[]> = new Map()

  onReady: ((instance: Masonry) => void) | null = null

  onError = (err: unknown) => console.error(err)

  onClick: ((event: ClickEvent) => void) | null = null

  constructor(options: Config) {
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

  #initConfig(options: Config) {
    if (!isCanvasSupported()) {
      throw new MasonryError('the current environment does not support the canvas API')
    }
    const { valid, errors } = this.#configValidator.validate(options)
    if (!valid) {
      throw new MasonryError(errors.join('\n'))
    }
    this.#canvas = options.canvas
    this.#canvasContext = options.canvas.getContext('2d')!
    this.#style = options.style
    this.#setupCanvas()
    if (options.onError && isFunction(options.onError)) {
      this.onError = options.onError
    }
    if (options.onReady && isFunction(options.onReady)) {
      this.onReady = options.onReady
    }
    if (options.onClick && isFunction(options.onClick)) {
      this.onClick = options.onClick
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

  #initializeGrid(options: Config) {
    this.#gridItems = chunk(this.#calculateItemPositions(options.items), this.columnCapacity)
    this.#render(this.#gridItems)
    this.#bindEvent()
    this.onReady?.(this)
  }

  #buildSpatialIndex() {
    this.#spatialIndex.clear()
    const items = flatten(this.#gridItems)
    for (const item of items) {
      const gridX = Math.floor(item.x / 50)
      const gridY = Math.floor(item.y / 50)
      const key = `${gridX},${gridY}`
      if (!this.#spatialIndex.has(key)) {
        this.#spatialIndex.set(key, [])
      }
      this.#spatialIndex.get(key)!.push(item)
    }
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

  #getCanvasRelativeCoordinates(event: MouseEvent): { x: number; y: number } {
    const rect = this.#canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    return {
      x: (event.clientX - rect.left) * dpr,
      y: (event.clientY - rect.top) * dpr,
    }
  }

  #isPointInRoundedRect(
    pointX: number,
    pointY: number,
    rectX: number,
    rectY: number,
    width: number,
    height: number,
    radius: number,
  ): boolean {
    if (pointX < rectX || pointX > rectX + width || pointY < rectY || pointY > rectY + height) {
      return false
    }
    if (radius <= 0) {
      return true
    }
    const corners = [
      { x: rectX + radius, y: rectY + radius, r: radius },
      { x: rectX + width - radius, y: rectY + radius, r: radius },
      { x: rectX + width - radius, y: rectY + height - radius, r: radius },
      { x: rectX + radius, y: rectY + height - radius, r: radius },
    ]
    const isXInner = pointX >= rectX + radius && pointX <= rectX + width - radius
    const isYInner = pointY >= rectY + radius && pointY <= rectY + height - radius
    if (isXInner || isYInner) {
      return true
    }
    for (const corner of corners) {
      const dx = pointX - corner.x
      const dy = pointY - corner.y
      if (dx * dx + dy * dy <= radius * radius) {
        return true
      }
    }
    return false
  }

  #getItemAtPosition(x: number, y: number): Omit<ClickEvent, 'event'> | null {
    const gridX = Math.floor(x / this.blockWidth)
    const gridY = Math.floor(y / this.blockHeight)
    const candidates: GridItem[] = []
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${gridX + dx},${gridY + dy}`
        const items = this.#spatialIndex.get(key)
        if (items) {
          candidates.push(...items)
        }
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i]
      const { x: itemX, y: itemY } = item
      const width = this.#style.width
      const height = this.#style.height
      const radius = this.radius
      if (x < itemX || x > itemX + width || y < itemY || y > itemY + height) {
        continue
      }
      if (this.#isPointInRoundedRect(x, y, itemX, itemY, width, height, radius)) {
        const column = Math.floor(itemX / this.blockWidth)
        const row = Math.floor(itemY / this.blockHeight)
        const allItems = flatten(this.#gridItems)
        const globalIndex = allItems.findIndex((it) => it === item)
        return {
          item,
          index: globalIndex,
          row,
          column,
        }
      }
    }
    return null
  }

  #isOutOfBounds(x: number, y: number) {
    const overflowX = x < -this.#style.width || x > this.#canvasWidth
    const overflowY = y < -this.#style.height || y > this.#canvasHeight
    return overflowX || overflowY
  }

  #calculateItemPositions(items: Array<CanvasImageSource>) {
    const result: Array<GridItem> = []
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

  #click(e: MouseEvent) {
    if (this.onClick) {
      const { x, y } = this.#getCanvasRelativeCoordinates(e)
      const clickedItem = this.#getItemAtPosition(x, y)
      if (clickedItem) {
        this.onClick({
          ...clickedItem,
          event: e,
        })
      }
    }
  }

  get events() {
    return {
      mousedown: this.#mousedown.bind(this),
      mouseup: this.#mouseup.bind(this),
      mouseleave: this.#mouseleave.bind(this),
      mousemove: this.#mousemove.bind(this),
      wheel: this.#wheel.bind(this),
      click: this.#click.bind(this),
    }
  }

  #bindEvent() {
    this.#canvas.addEventListener('mousedown', this.events.mousedown)
    this.#canvas.addEventListener('mouseup', this.events.mouseup)
    this.#canvas.addEventListener('mouseleave', this.events.mouseleave)
    this.#canvas.addEventListener('mousemove', this.events.mousemove)
    this.#canvas.addEventListener('wheel', this.events.wheel)
    this.#canvas.addEventListener('click', this.events.click)
    this.#resizeObserver.observe(this.#canvas)
  }

  #unbindEvent() {
    this.#canvas.removeEventListener('mousedown', this.events.mousedown)
    this.#canvas.removeEventListener('mouseup', this.events.mouseup)
    this.#canvas.removeEventListener('mouseleave', this.events.mouseleave)
    this.#canvas.removeEventListener('mousemove', this.events.mousemove)
    this.#canvas.removeEventListener('wheel', this.events.wheel)
    this.#canvas.removeEventListener('click', this.events.click)
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
    const afterImages: Array<Array<GridItem>> = []
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

  #appendHorizontalItems(row: GridItem[], x: number): Array<GridItem> {
    if (row.length === 0) {
      return row
    }
    const afterRow: GridItem[] = []
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

  #appendVerticalItems(images: Array<Array<GridItem>>, y: number) {
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

  #columnPatch(row: GridItem[], newY: number): GridItem[] {
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
      ctx.roundRect(x, y, w, h, radius)
      ctx.clip()
      ctx.drawImage(source, x, y, w, h)
      ctx.restore()
    }
  }

  #render(images: Array<Array<GridItem>>) {
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
    this.#buildSpatialIndex()
  }
}
