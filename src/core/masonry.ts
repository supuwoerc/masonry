import { isFunction } from 'lodash-es'

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
  index: number
  crossX: boolean
  crossY: boolean
}

interface PatchImageInfo extends ImageInfo {
  from: number
}

export default class Masonry {
  #canvas!: HTMLCanvasElement

  #canvasContext!: CanvasRenderingContext2D

  #moveable = false

  #disabled = false

  #gap = 0

  #images: Array<ImageInfo> = []

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
      this.#images = this.#setImagesPosition(images)
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

  enable() {
    this.#disabled = false
  }

  disable() {
    this.#disabled = true
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

  #getCrossX(x: number) {
    const corssRight
      = x < this.#canvasWidth && x + this.#itemWidth > this.#canvasWidth
    const corssLeft = x < 0 && x > -this.#itemWidth
    return corssRight || corssLeft
  }

  #getCrossY(y: number) {
    const corssBottom
      = y < this.#canvasHeight && y + this.#itemHeight > this.#canvasHeight
    const corssTop = y < 0 && y > -this.#itemHeight
    return corssBottom || corssTop
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
      const crossX = this.#getCrossX(x)
      const crossY = this.#getCrossY(y)
      result.push({ image, x, y, index, crossX, crossY })
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
    if (this.#moveable && !this.#disabled) {
      this.#move(e.movementX, e.movementY)
    }
  }

  get events() {
    return {
      mousedown: this.#mousedown.bind(this),
      mouseup: this.#mouseup.bind(this),
      mouseleave: this.#mouseleave.bind(this),
      mousemove: this.#mousemove.bind(this),
    }
  }

  #bindEvent() {
    this.#canvas.addEventListener('mousedown', this.events.mousedown)
    this.#canvas.addEventListener('mouseup', this.events.mouseup)
    this.#canvas.addEventListener('mouseleave', this.events.mouseleave)
    this.#canvas.addEventListener('mousemove', this.events.mousemove)
    this.#resizeObserver.observe(this.#canvas)
  }

  #unbindEvent() {
    this.#canvas.removeEventListener('mousedown', this.events.mousedown)
    this.#canvas.removeEventListener('mouseup', this.events.mouseup)
    this.#canvas.removeEventListener('mouseleave', this.events.mouseleave)
    this.#canvas.removeEventListener('mousemove', this.events.mousemove)
    this.#resizeObserver.disconnect()
  }

  #move(x: number, _y: number) {
    this.clear()
    const removeIndex: number[] = []
    const patchImages: PatchImageInfo[] = []
    const toRight = x > 0
    const toLeft = x < 0
    this.#images.forEach((info, index) => {
      info.x += x
      if (toRight && info.x + this.#itemWidth > this.#canvasWidth) {
        const oppositeIndex = index - this.columnSize
        const opposite = this.#images[oppositeIndex]
        const isNeedPatch = opposite && !this.#getCrossX(opposite.x)
        if (isNeedPatch) {
          patchImages.push({
            image: info.image,
            x: info.x - this.#canvasWidth,
            y: info.y,
            index: oppositeIndex + Math.floor(index / this.columnCapacity),
            from: index,
            crossX: this.#getCrossX(info.x - this.#canvasWidth),
            crossY: this.#getCrossY(info.y),
          })
        }
        if (this.#getOverflow(info.x, info.y)) {
          removeIndex.push(index)
        }
      }
      if (toLeft && info.x < 0) {
        const oppositeIndex = index + this.columnSize
        const opposite = this.#images[oppositeIndex]
        if (opposite && !this.#getCrossX(opposite.x)) {
          patchImages.push({
            image: info.image,
            x: this.#canvasWidth - info.x,
            y: info.y,
            index:
              oppositeIndex
              + Math.floor(oppositeIndex / this.columnCapacity)
              + 1,
            from: index,
            crossX: this.#getCrossX(this.#canvasWidth - info.x),
            crossY: this.#getCrossY(info.y),
          })
        }
      }
    })
    patchImages.sort((left, right) => left.index - right.index)
    patchImages.forEach((item) => {
      this.#images.splice(item.index, 0, item)
    })
    this.#images = this.#images.filter(
      (_, index) => !removeIndex.includes(index),
    )
    this.#images.forEach((item, index) => {
      item.index = index
    })
    this.#render(this.#images)
  }

  resize() {
    this.#canvas.width = this.#canvas.clientWidth
    this.#canvas.height = this.#canvas.clientHeight
    this.#canvasWidth = this.#canvas.clientWidth
    this.#canvasHeight = this.#canvas.clientHeight
    if (this.#images.length > 0) {
      this.clear()
      this.#render(this.#images)
    }
  }

  #render(images: Array<ImageInfo>) {
    const w = this.#itemWidth
    const h = this.#itemHeight
    for (let index = 0; index < images.length; index++) {
      const { image, x, y } = images[index]
      this.#canvasContext?.drawImage(image, x, y, w, h)
    }
  }
}
