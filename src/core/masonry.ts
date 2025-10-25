import { chunk, flatten, isFunction } from 'lodash-es'

export interface MasonryItemStyle {
  width: number
  height: number
  radius?: number
}
export interface MasonryOptions {
  canvas: HTMLCanvasElement
  gap?: number
  items: Array<string>
  style: MasonryItemStyle
  itemWidth: number
  itemHeight: number
  onReady?: (instance: Masonry) => void
  onError?: (err: unknown) => void
}

interface ImageInfo {
  image: HTMLImageElement
  x: number
  y: number
}

export default class Masonry {
  #canvas!: HTMLCanvasElement

  #canvasContext!: CanvasRenderingContext2D

  #moveable = false

  #scrollable = true

  #disabled = {
    horizontal: false,
    vertical: false,
  }

  #gap = 0

  #images: Array<Array<ImageInfo>> = []

  #itemWidth = 0

  #itemHeight = 0

  #canvasWidth = 0

  #canvasHeight = 0

  #resizeObserver = new ResizeObserver(() => this.resize())

  onReady: ((instance: Masonry) => void) | null = null

  onError = (err: unknown) => console.error(err)

  constructor(options: MasonryOptions) {
    this.#initConfig(options)
    this.#draw(options)
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
    return this.#itemWidth + this.#gap
  }

  get blockHeight() {
    return this.#itemHeight + this.#gap
  }

  #initConfig(options: MasonryOptions) {
    if (options.items.length <= 0) {
      throw new Error('items is required')
    }
    if (options.itemWidth <= 0) {
      throw new Error('item width must > 0')
    }
    if (options.itemWidth <= 0) {
      throw new Error('item height must > 0')
    }
    if ((options?.gap ?? 0) < 0) {
      throw new Error('item gap must >= 0')
    }
    if (!options.canvas.getContext('2d')) {
      throw new Error('2d context of canvas not supported or available')
    }
    if (options.onError && !isFunction(options.onError)) {
      throw new Error('onError is not a valid callback function')
    }
    this.#canvas = options.canvas
    this.#canvasContext = options.canvas.getContext('2d')!
    this.#itemWidth = options.itemWidth
    this.#itemHeight = options.itemHeight
    this.#gap = options?.gap ?? 20
    this.#canvas.width = this.#canvas.clientWidth
    this.#canvas.height = this.#canvas.clientHeight
    this.#canvasWidth = this.#canvas.clientWidth
    this.#canvasHeight = this.#canvas.clientHeight
    if (options.onError && isFunction(options.onError)) {
      this.onError = options.onError
    }
    if (options.onReady && isFunction(options.onReady)) {
      this.onReady = options.onReady
    }
  }

  async #prepareImages(options: MasonryOptions) {
    try {
      const images = await this.#loadImages(options.items)
      this.#images = chunk(
        this.#setImagesPosition(images),
        this.columnCapacity,
      )
    } catch (error) {
      this.onError(error)
    }
  }

  async #draw(options: MasonryOptions) {
    try {
      await this.#prepareImages(options)
      this.#render(this.#images)
      this.#bindEvent()
      this.onReady?.(this)
    } catch (error) {
      this.onError(error)
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

  async #loadImages(items: Array<string>) {
    const imagePromises = items.map((url, index) => {
      return new Promise<{ image: HTMLImageElement, index: number }>(
        (resolve, reject) => {
          const image = new Image()
          image.onload = () => {
            resolve({ image, index })
          }
          image.onerror = () => {
            reject(new Error(`failed to load: ${url}`))
          }
          image.src = url
        },
      )
    })
    const results = await Promise.allSettled(imagePromises)
    const rejected = results.filter((r) => r.status === 'rejected')
    if (rejected.length > 0) {
      const reasons = rejected.map((item) => item.reason)
      return Promise.reject(reasons)
    }
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const images = fulfilled.map((item) => item.value)
    images.sort((left, right) => left.index - right.index)
    return Promise.resolve(images.map((item) => item.image))
  }

  #getOverflow(x: number, y: number) {
    const overflowX = x < -this.#itemWidth || x > this.#canvasWidth
    const overflowY = y < -this.#itemHeight || y > this.#canvasHeight
    return overflowX || overflowY
  }

  #setImagesPosition(images: Array<HTMLImageElement>) {
    const result: Array<ImageInfo> = []
    for (
      let index = 0;
      index < this.columnCapacity * this.rowCapacity;
      index++
    ) {
      const column = index % this.columnCapacity
      const row = Math.floor(index / this.columnCapacity)
      const x = column * this.blockWidth
      const y = row * this.blockHeight
      const image = images[index % images.length]
      result.push({ image, x, y })
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
      this.#move(e.movementX, e.movementY)
    }
  }

  #wheel(e: WheelEvent) {
    e.preventDefault()
    if (this.#disabled.vertical || !this.#scrollable) {
      return
    }
    this.#move(0, -e.deltaY)
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

  #move(x: number, y: number) {
    if (this.#disabled.horizontal && this.#disabled.vertical) {
      return
    }
    this.clear()
    flatten(this.#images).forEach((item) => {
      !this.#disabled.horizontal && (item.x += x)
      !this.#disabled.vertical && (item.y += y)
    })
    const afterImages: Array<Array<ImageInfo>> = []
    this.#images.forEach((row) => {
      if (row.length === 0) {
        return
      }
      const afterRow: ImageInfo[] = []
      const leftmost = row[0]
      const rightmost = row[row.length - 1]
      if (x > 0 && leftmost.x > this.#gap) {
        afterRow.push({
          image: rightmost.image,
          x: leftmost.x - this.blockWidth,
          y: leftmost.y,
        })
      }
      row.forEach((element) => {
        if (!this.#getOverflow(element.x, element.y)) {
          afterRow.push(element)
        }
      })
      if (x < 0 && rightmost.x < this.#canvasWidth - this.blockWidth) {
        afterRow.push({
          image: leftmost.image,
          x: rightmost.x + this.blockWidth,
          y: rightmost.y,
        })
      }
      if (afterRow.length > 0) {
        afterImages.push(afterRow)
      }
    })
    if (y !== 0) {
      this.#handleVerticalPatch(afterImages, y)
    }
    this.#images = afterImages
    this.#render(this.#images)
  }

  #handleVerticalPatch(images: Array<Array<ImageInfo>>, y: number) {
    if (images.length === 0) {
      return
    }
    const firstRow = images[0]
    const lastRow = images[images.length - 1]
    if (y > 0 && firstRow[0] && firstRow[0].y > this.#gap) {
      const patch = this.#columnPatch(
        lastRow,
        firstRow[0].y - this.blockHeight,
      )
      images.unshift(patch)
    }

    if (
      y < 0
      && lastRow[0]
      && lastRow[0].y < this.#canvasHeight - this.blockHeight
    ) {
      const patch = this.#columnPatch(
        firstRow,
        lastRow[0].y + this.blockHeight,
      )
      images.push(patch)
    }
  }

  #columnPatch(row: ImageInfo[], newY: number): ImageInfo[] {
    return row.map((template) => ({
      image: template.image,
      x: template.x,
      y: newY,
    }))
  }

  resize() {
    // FIXME:resize
    this.#canvas.width = this.#canvas.clientWidth
    this.#canvas.height = this.#canvas.clientHeight
    this.#canvasWidth = this.#canvas.clientWidth
    this.#canvasHeight = this.#canvas.clientHeight
    if (this.#images.length > 0) {
      this.#images = chunk(flatten(this.#images), this.columnCapacity)
      this.clear()
      this.#render(this.#images)
    }
  }

  #render(images: Array<Array<ImageInfo>>) {
    if (images.length > 0) {
      const w = this.#itemWidth
      const h = this.#itemHeight
      const list = flatten(images)
      for (let index = 0; index < list.length; index++) {
        const { image, x, y } = list[index]
        this.#canvasContext?.drawImage(image, x, y, w, h)
      }
    }
  }
}
