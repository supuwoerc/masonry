import { isFunction } from '../utils'

export interface MasonryItemStyle {
  width: number
  height: number
  radius?: number
}
export interface MasonryOptions {
  canvas: HTMLCanvasElement
  gap?: number
  redundancy?: number
  items: Array<string>
  style: MasonryItemStyle
  itemWidth: number
  itemHeight: number
  onReady?: (instance: Masonry) => void
  onError?: (err: Error) => void
}

interface ImageWithPositionInfo {
  image: HTMLImageElement
  x: number
  y: number
}

export default class Masonry {
  #canvas!: HTMLCanvasElement

  #canvasContext!: CanvasRenderingContext2D

  #moveable = false

  #disabled = false

  #gap = 0

  #images: Array<ImageWithPositionInfo> = []

  #redundancy = 1

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

  get capacityX() {
    return Math.ceil(this.#canvasWidth / (this.#itemWidth + this.#gap))
  }

  get capacityY() {
    return Math.ceil(this.#canvasHeight / (this.#itemHeight + this.#gap))
  }

  get rangeWidth() {
    const width = this.#itemWidth + this.#gap
    return this.#canvasWidth + this.#redundancy * 2 * width
  }

  get rangeHeight() {
    const height = this.#itemHeight + this.#gap
    return this.#canvasHeight + this.#redundancy * 2 * height
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
    if ((options?.redundancy ?? 1) < 1) {
      throw new Error('redundancy must >= 1')
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
    this.#redundancy = options?.redundancy ?? 1
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

  #setImagesPosition(images: Array<HTMLImageElement>) {
    const rowCount = this.capacityY + 2 * this.#redundancy
    const columnCount = this.capacityX + 2 * this.#redundancy
    const result: Array<ImageWithPositionInfo> = []
    const offsetX = this.#redundancy * this.blockWidth
    const offsetY = this.#redundancy * this.blockHeight
    for (let i = 0; i < rowCount * columnCount; i++) {
      const column = i % columnCount
      const row = Math.floor(i / columnCount)
      const x = column * this.blockWidth - offsetX
      const y = row * this.blockHeight - offsetY
      const image = images[i % images.length]
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
    if (this.#moveable && !this.#disabled) {
      this.#move(e.movementX, e.movementY)
    }
  }

  events = {
    mousedown: this.#mousedown.bind(this),
    mouseup: this.#mouseup.bind(this),
    mouseleave: this.#mouseleave.bind(this),
    mousemove: this.#mousemove.bind(this),
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

  #move(x: number, y: number) {
    this.clear()
    this.#images.forEach((imageInfo) => {
      imageInfo.x += x
      if (imageInfo.x > this.rangeWidth - this.#itemWidth) {
        imageInfo.x -= this.rangeWidth + this.#gap
      }
      if (imageInfo.x < -this.#itemWidth) {
        imageInfo.x += this.rangeWidth + this.#gap
      }
      imageInfo.y += y
      if (imageInfo.y > this.rangeHeight - this.#itemHeight) {
        imageInfo.y -= this.rangeHeight + this.#gap
      }
      if (imageInfo.y < -this.#itemHeight) {
        imageInfo.y += this.rangeHeight + this.#gap
      }
      this.#canvasContext?.drawImage(
        imageInfo.image,
        imageInfo.x,
        imageInfo.y,
        this.#itemWidth,
        this.#itemHeight,
      )
    })
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

  #render(images: Array<ImageWithPositionInfo>) {
    const w = this.#itemWidth
    const h = this.#itemHeight
    for (let index = 0; index < images.length; index++) {
      const { image, x, y } = images[index]
      this.#canvasContext?.drawImage(image, x, y, w, h)
    }
  }
}
