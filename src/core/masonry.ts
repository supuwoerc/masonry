import type {
  ClickEvent,
  GridItem,
  GridItemStyle,
  LoadMoreConfig,
  PlaceholderRenderer,
} from './types'
import type { WorkerMessage } from './worker/types'
import { chunk, isFunction } from 'lodash-es'
import { Validator } from '@/helper/validator'
import { isCanvasSupported, isWorkerSupported } from '@/utils/canvas'
import { setupCanvas } from './common/setup'
import { WorkerMessageType } from './constant'
import { MasonryError } from './error'
import { configurationRules } from './rules'
import 'path2d-polyfill'

export interface MasonryConfiguration {
  core: {
    canvas: HTMLCanvasElement
    items?: CanvasImageSource[]
    style: GridItemStyle
  }

  interaction?: {
    onClick?: (event: ClickEvent) => void
    disabled?: {
      horizontal?: boolean
      vertical?: boolean
    }
  }

  loader?: {
    pageSize: number
    loadMore: (page: number, pageSize: number) => Promise<CanvasImageSource[]>
  }

  placeholder?: {
    renderer: PlaceholderRenderer
  }

  events?: {
    onReady?: (instance: Masonry) => void
    onError?: (err: unknown) => void
  }
}

export class Masonry {
  #canvas!: HTMLCanvasElement

  #canvasContext!: CanvasRenderingContext2D

  #worker: Worker | null = null

  #offscreenCanvas: OffscreenCanvas | null = null

  #useWorker = false

  #workerReady = false

  #moveable = false

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

  #validator = new Validator<MasonryConfiguration>(configurationRules)

  #spatialIndex: Map<string, GridItem[]> = new Map()

  #allItems: CanvasImageSource[] = []

  #pagination = {
    loading: false,
    page: 1,
    hasMore: true,
  }

  #loadMoreConfig: LoadMoreConfig | null = null

  #config: MasonryConfiguration

  #placeholderRenderer: PlaceholderRenderer | null = null

  onReady: ((instance: Masonry) => void) | null = null

  onError = (err: unknown) => console.error(err)

  onClick: ((event: ClickEvent) => void) | null = null

  constructor(config: MasonryConfiguration) {
    if (!isCanvasSupported()) {
      throw new MasonryError('The current environment does not support the canvas API')
    }
    const { valid, errors } = this.#validator.validate(config)
    if (!valid) {
      throw new MasonryError(errors.join('\n'))
    }
    this.#config = config
    this.#init()
  }

  #init() {
    this.#initCore(this.#config)
    this.#initEvents(this.#config)
    this.#initInteraction(this.#config)
    this.#initLoader(this.#config)
    this.#initPlaceholder(this.#config)
    this.#initPerformance(this.#config)
    this.#setupCanvas()
    this.#initializeGrid()
  }

  #initCore(config: MasonryConfiguration) {
    this.#canvas = config.core.canvas
    this.#style = config.core.style
    if (isWorkerSupported()) {
      this.#useWorker = true
      this.#initWorker()
    } else {
      this.#canvasContext = config.core.canvas.getContext('2d')!
    }
  }

  #initWorker() {
    try {
      this.#worker = new Worker(new URL('./worker/offscreen-canvas.ts', import.meta.url), {
        type: 'module',
      })
      this.#offscreenCanvas = this.#canvas.transferControlToOffscreen()
      this.#worker.onmessage = this.#handleWorkerMessage.bind(this)
      this.#worker.onerror = this.#handleWorkerError.bind(this)
      const initPayload = {
        canvas: this.#offscreenCanvas,
        style: this.#style,
        width: this.#canvasWidth,
        height: this.#canvasHeight,
        dpr: window.devicePixelRatio || 1,
      }
      this.#worker.postMessage(
        {
          type: WorkerMessageType.Init,
          payload: initPayload,
          id: `init_${Date.now()}`,
        },
        [this.#offscreenCanvas],
      )
    } catch (error) {
      this.#useWorker = false
      this.#worker = null
      this.#offscreenCanvas = null
      this.#canvasContext = this.#canvas.getContext('2d')!
      this.onError(error)
    }
  }

  #initEvents(config: MasonryConfiguration) {
    if (config.events?.onError && isFunction(config.events.onError)) {
      this.onError = config.events.onError
    }
    if (config.events?.onReady && isFunction(config.events.onReady)) {
      this.onReady = config.events.onReady
    }
  }

  #initInteraction(config: MasonryConfiguration) {
    if (config.interaction?.onClick && isFunction(config.interaction.onClick)) {
      this.onClick = config.interaction.onClick
    }
    if (config.interaction?.disabled) {
      this.#disabled.horizontal = config.interaction.disabled.horizontal ?? false
      this.#disabled.vertical = config.interaction.disabled.vertical ?? false
    }

    // 可以在这里添加其他交互初始化，如 hover、draggable 等
    // if (config.interaction?.onHover && isFunction(config.interaction.onHover)) {
    //   this.onHover = config.interaction.onHover
    // }
  }

  #initLoader(config: MasonryConfiguration) {
    if (config.loader) {
      this.#loadMoreConfig = config.loader
      this.#allItems = []
    } else {
      this.#allItems = config.core.items ?? []
    }
  }

  #initPlaceholder(config: MasonryConfiguration) {
    this.#placeholderRenderer = config?.placeholder?.renderer ?? null
  }

  #initPerformance(_config: MasonryConfiguration) {
    // 当前没有性能相关的初始化逻辑
    // 为未来扩展预留，可以初始化缓存大小、防抖时间等
    // if (config.performance?.cacheSize) {
    //   this.#cacheSize = config.performance.cacheSize
    // }
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

  #setupCanvas() {
    if (!this.#useWorker) {
      setupCanvas(this.#canvas, this.#canvasContext)
      this.#canvasWidth = this.#canvas.clientWidth
      this.#canvasHeight = this.#canvas.clientHeight
    }
  }

  #initializeGrid() {
    this.#gridItems = chunk(this.#calculateItemPositions(), this.columnCapacity)
    this.#render(this.#gridItems)
    this.#bindEvent()
    this.onReady?.(this)
  }

  #buildSpatialIndex() {
    this.#spatialIndex.clear()
    const items = this.#gridItems.flat()
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
    if (this.#useWorker && this.#workerReady && this.#worker) {
      this.#worker.postMessage({
        type: WorkerMessageType.Clear,
        id: `clear-${Date.now()}`,
      })
    } else {
      this.#canvasContext?.clearRect(0, 0, this.#canvasWidth, this.#canvasHeight)
    }
  }

  destroy() {
    this.#unbindEvent()
    this.clear()
    if (this.#worker) {
      this.#worker.terminate()
      this.#worker = null
    }
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
        const globalIndex = this.#gridItems.flat().findIndex((it) => it === item)
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

  #calculateItemPositions() {
    const result: Array<GridItem> = []
    const count = this.columnCapacity * this.rowCapacity

    for (let index = 0; index < count; index++) {
      const column = index % this.columnCapacity
      const row = Math.floor(index / this.columnCapacity)
      const x = column * this.blockWidth
      const y = row * this.blockHeight

      let source: CanvasImageSource

      if (this.#allItems.length === 0) {
        // 如果没有 items，使用占位符
        source = this.#createPlaceholder(index)
      } else if (index < this.#allItems.length) {
        source = this.#allItems[index]
      } else if (this.#pagination.hasMore && !this.#pagination.loading) {
        // 触发加载更多
        this.#loadMoreItems()
        // 临时使用最后一张图片或占位符
        source = this.#allItems[this.#allItems.length - 1] || this.#createPlaceholder(index)
      } else {
        // 没有更多数据时，循环使用现有图片
        source = this.#allItems[index % this.#allItems.length]
      }

      result.push({ source, x, y })
    }
    return result
  }

  async #loadMoreItems(): Promise<void> {
    const { loading, hasMore } = this.#pagination
    if (!this.#loadMoreConfig || !this.#loadMoreConfig.loadMore || loading || !hasMore) {
      return
    }
    this.#pagination.loading = true
    try {
      const next = this.#pagination.page + 1
      const list = await this.#loadMoreConfig.loadMore(next, this.#loadMoreConfig.pageSize)
      if (list && list.length > 0) {
        this.#allItems.push(...list)
        this.#pagination.page = next
        if (list.length < this.#loadMoreConfig.pageSize) {
          this.#pagination.hasMore = false
        }
        this.#refreshGrid()
      } else {
        this.#pagination.hasMore = false
      }
    } catch (error) {
      this.onError(error)
    } finally {
      this.#pagination.loading = false
    }
  }

  #refreshGrid() {
    this.#gridItems = chunk(this.#calculateItemPositions(), this.columnCapacity)
    this.clear()
    this.#render(this.#gridItems)
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
    if (this.#disabled.vertical) {
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
    this.#gridItems.flat().forEach((item) => {
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
      const newIndex = this.#getNextItemIndex()
      afterRow.push({
        source: this.#getItemByIndex(newIndex),
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
      const newIndex = this.#getNextItemIndex()
      afterRow.push({
        source: this.#getItemByIndex(newIndex),
        x: rightmost.x + this.blockWidth,
        y: rightmost.y,
      })
    }
    return afterRow
  }

  #getNextItemIndex(): number {
    const totalItems = this.#allItems.length
    if (totalItems === 0) {
      return 0 // 返回 0，会使用占位符
    }

    const currentItems = this.#gridItems.flat()
    const maxIndex = Math.max(
      ...currentItems.map((item) => this.#allItems.indexOf(item.source)),
      -1,
    )

    const nextIndex = maxIndex + 1

    if (nextIndex >= totalItems && this.#pagination.hasMore && !this.#pagination.loading) {
      this.#loadMoreItems()
    }

    return nextIndex % totalItems
  }

  #getItemByIndex(index: number): CanvasImageSource {
    if (this.#allItems.length === 0) {
      return this.#createPlaceholder(index)
    }
    if (index < this.#allItems.length) {
      return this.#allItems[index]
    }
    // 如果索引超出范围，返回第一个项目或占位符
    return this.#allItems[0] || this.#createPlaceholder(index)
  }

  #createPlaceholder(index = 0): CanvasImageSource {
    if (!this.#placeholderRenderer) {
      return this.#createTransparentCanvas()
    }

    return this.#placeholderRenderer.render(this.#style.width, this.#style.height, index)
  }

  #createTransparentCanvas(): CanvasImageSource {
    const canvas = document.createElement('canvas')
    canvas.width = this.#style.width
    canvas.height = this.#style.height
    return canvas
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
    this.#setupCanvas()
    if (this.#gridItems.length > 0) {
      this.#gridItems = chunk(this.#gridItems.flat(), this.columnCapacity)
      this.clear()
      this.#render(this.#gridItems)

      if (this.#useWorker && this.#worker && this.#offscreenCanvas) {
        this.#workerReady = false

        const initPayload = {
          canvas: this.#offscreenCanvas,
          style: this.#style,
          width: this.#canvasWidth,
          height: this.#canvasHeight,
          dpr: window.devicePixelRatio || 1,
        }

        this.#worker.postMessage({
          type: WorkerMessageType.Init,
          payload: initPayload,
          id: `resize-init-${Date.now()}`,
        })
      }
    }
  }

  #handleWorkerMessage(event: MessageEvent<WorkerMessage>) {
    const { type, payload } = event.data
    switch (type) {
      case WorkerMessageType.InitResponse:
        this.#workerReady = true
        break
      case WorkerMessageType.Error:
        this.#handleWorkerError(payload as any)
        break
    }
  }

  #handleWorkerError(error: ErrorEvent) {
    console.error('Worker error:', error)
    this.onError?.(error)

    // Worker出错时回退到主线程渲染
    if (this.#worker) {
      this.#worker.terminate()
      this.#worker = null
      this.#workerReady = false
      this.#useWorker = false
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
    if (images.length === 0) {
      return
    }
    if (this.#useWorker && this.#workerReady && this.#worker) {
      this.#renderWithWorker(images)
    } else {
      // 回退到主线程渲染
      this.#renderOnMainThread(images)
    }
    this.#buildSpatialIndex()
  }

  #renderWithWorker(images: Array<Array<GridItem>>) {
    if (!this.#worker) {
      return
    }
    const renderPayload = {
      items: images,
      clearBeforeRender: true,
    }
    this.#worker.postMessage({
      type: WorkerMessageType.Render,
      payload: renderPayload,
      id: `render-${Date.now()}`,
    })
  }

  #renderOnMainThread(images: Array<Array<GridItem>>) {
    if (images.length > 0) {
      const w = this.#style.width
      const h = this.#style.height
      const list = images.flat()
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
