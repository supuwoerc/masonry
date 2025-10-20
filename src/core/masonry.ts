import { isFunction } from "../utils";

export interface MasonryOptions {
  canvas: HTMLCanvasElement;
  gap?: number;
  redundancy?: number;
  items: Array<string>;
  itemWidth: number;
  itemHeight: number;
  onError?: (err: Error) => void;
}

interface ImageWithPositionInfo {
  image: HTMLImageElement;
  x: number;
  y: number;
}

export default class Masonry {
  #canvas!: HTMLCanvasElement;

  #canvasContext!: CanvasRenderingContext2D;

  #moveable = false;

  #gap = 0;

  #images: Array<ImageWithPositionInfo> = [];

  #redundancy = 1;

  #itemWidth = 0;

  #itemHeight = 0;

  #resizeObserver = new ResizeObserver(() => this.resize());

  onError = (err: Error) => console.error(err);

  constructor(options: MasonryOptions) {
    this.init(options);
    this.draw(options).then(() => this.bindEvent());
  }

  get canvasWidth() {
    return this.#canvas.clientWidth;
  }

  get canvasHeight() {
    return this.#canvas.clientHeight;
  }

  get capacityX() {
    return Math.ceil(this.canvasWidth / (this.#itemWidth + this.#gap));
  }

  get capacityY() {
    return Math.ceil(this.canvasHeight / (this.#itemHeight + this.#gap));
  }

  get rangeWidth() {
    const width = this.#itemWidth + this.#gap;
    return this.canvasWidth + this.#redundancy * 2 * width - this.#gap;
  }

  get rangeHeight() {
    const height = this.#itemHeight + this.#gap;
    return this.canvasHeight + this.#redundancy * 2 * height - this.#gap;
  }

  init(options: MasonryOptions) {
    if (options.items.length <= 0) {
      throw new Error("items is required");
    }
    if (options.itemWidth <= 0) {
      throw new Error("item width must > 0");
    }
    if (options.itemWidth <= 0) {
      throw new Error("item height must > 0");
    }
    if (options?.gap ?? 0 < 0) {
      throw new Error("item gap must >= 0");
    }
    if (options?.redundancy ?? 1 < 1) {
      throw new Error("redundancy must >= 1");
    }
    if (!options.canvas.getContext("2d")) {
      throw new Error("2d context of canvas not supported or available");
    }
    if (options.onError && !isFunction(options.onError)) {
      throw new Error("onError is not a valid callback function");
    }
    this.#canvas = options.canvas;
    this.#canvasContext = options.canvas.getContext("2d")!;
    this.#itemWidth = options.itemWidth;
    this.#itemHeight = options.itemHeight;
    this.#gap = options?.gap || 20;
    this.#redundancy = options?.redundancy ?? 1;
    this.#canvas.width = this.#canvas.clientWidth;
    this.#canvas.height = this.#canvas.clientHeight;
  }

  draw(options: MasonryOptions) {
    return this.loadImages(options.items)
      .then((images) => this.setImagesPosition(images))
      .then((images) => {
        this.#images = images;
        return images;
      })
      .then((images) => this.render(images))
      .catch((e) => {
        console.error(e);
        this.onError(e);
      });
  }

  destroy() {
    this.#resizeObserver.disconnect();
  }

  async loadImages(items: Array<string>) {
    const imagePromises = items.map((url, index) => {
      return new Promise<{ image: HTMLImageElement; index: number }>(
        (resolve, reject) => {
          const image = new Image();
          image.onload = () => {
            resolve({ image, index });
          };
          image.onerror = () => {
            reject(new Error(`failed to load: ${url}`));
          };
          image.src = url;
        },
      );
    });
    const results = await Promise.allSettled(imagePromises);
    const rejected = results.filter((r) => r.status === "rejected");
    if (rejected.length > 0) {
      const reasons = rejected.map((item) => item.reason);
      return Promise.reject(reasons);
    }
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const images = fulfilled.map((item) => item.value);
    images.sort((left, right) => left.index - right.index);
    return Promise.resolve(images.map((item) => item.image));
  }

  setImagesPosition(images: Array<HTMLImageElement>) {
    const rowCount = this.capacityY + 2 * this.#redundancy;
    const columnCount = this.capacityX + 2 * this.#redundancy;
    const result: Array<ImageWithPositionInfo> = [];
    for (let i = 0; i < rowCount * columnCount; i++) {
      const column = i % columnCount;
      const row = Math.floor(i / columnCount);
      const x = column * (this.#itemWidth + this.#gap);
      const y = row * (this.#itemHeight + this.#gap);
      result.push({
        image: images[i % images.length],
        x,
        y,
      });
    }
    return result;
  }

  bindEvent() {
    this.#canvas.addEventListener("mousedown", () => {
      this.#moveable = true;
    });
    this.#canvas.addEventListener("mouseup", () => {
      this.#moveable = false;
    });
    this.#canvas.addEventListener("mouseleave", () => {
      this.#moveable = false;
    });
    this.#canvas.addEventListener("mousemove", (e) => {
      if (this.#moveable) {
        this.move(e.movementX, e.movementY);
      }
    });
    this.#resizeObserver.observe(this.#canvas);
  }

  move(x: number, y: number) {
    this.#canvasContext?.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    this.#images.forEach((imageInfo) => {
      imageInfo.x += x;
      if (imageInfo.x > this.rangeWidth - this.#itemWidth) {
        imageInfo.x -= this.rangeWidth + this.#gap;
      }
      if (imageInfo.x < -this.#itemWidth) {
        imageInfo.x += this.rangeWidth + this.#gap;
      }
      imageInfo.y += y;
      if (imageInfo.y > this.rangeHeight - this.#itemHeight) {
        imageInfo.y -= this.rangeHeight + this.#gap;
      }
      if (imageInfo.y < -this.#itemHeight) {
        imageInfo.y += this.rangeHeight + this.#gap;
      }
      this.#canvasContext?.drawImage(
        imageInfo.image,
        imageInfo.x,
        imageInfo.y,
        this.#itemWidth,
        this.#itemHeight,
      );
    });
  }

  resize() {
    const currentTransform = this.#canvasContext?.getTransform();
    this.#canvas.width = this.#canvas.clientWidth;
    this.#canvas.height = this.#canvas.clientHeight;
    console.log("resize handle");
    if (currentTransform) {
      this.#canvasContext?.setTransform(currentTransform);
    }
    if (this.#images.length > 0) {
      this.render(this.#images);
    }
  }

  render(images: Array<ImageWithPositionInfo>) {
    const w = this.#itemWidth;
    const h = this.#itemHeight;
    for (let index = 0; index < images.length; index++) {
      const { image, x, y } = images[index];
      this.#canvasContext?.drawImage(image, x, y, w, h);
    }
  }
}
