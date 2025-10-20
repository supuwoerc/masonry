var masonry = (function (o) {
  "use strict";
  function u(l) {
    return typeof l == "function";
  }
  class g {
    #t;
    #r;
    #n = !1;
    #e = 0;
    #a = [];
    #h = 1;
    #i = 0;
    #s = 0;
    #c = new ResizeObserver(() => this.resize());
    onError = (t) => console.error(t);
    constructor(t) {
      (this.init(t), this.draw(t).then(() => this.bindEvent()));
    }
    get canvasWidth() {
      return this.#t.clientWidth;
    }
    get canvasHeight() {
      return this.#t.clientHeight;
    }
    get capacityX() {
      return Math.ceil(this.canvasWidth / (this.#i + this.#e));
    }
    get capacityY() {
      return Math.ceil(this.canvasHeight / (this.#s + this.#e));
    }
    get rangeWidth() {
      const t = this.#i + this.#e;
      return this.canvasWidth + this.#h * 2 * t - this.#e;
    }
    get rangeHeight() {
      const t = this.#s + this.#e;
      return this.canvasHeight + this.#h * 2 * t - this.#e;
    }
    init(t) {
      if (t.items.length <= 0) throw new Error("items is required");
      if (t.itemWidth <= 0) throw new Error("item width must > 0");
      if (t.itemWidth <= 0) throw new Error("item height must > 0");
      if (t?.gap ?? !1) throw new Error("item gap must >= 0");
      if (t?.redundancy ?? !1) throw new Error("redundancy must >= 1");
      if (!t.canvas.getContext("2d"))
        throw new Error("2d context of canvas not supported or available");
      if (t.onError && !u(t.onError))
        throw new Error("onError is not a valid callback function");
      ((this.#t = t.canvas),
        (this.#r = t.canvas.getContext("2d")),
        (this.#i = t.itemWidth),
        (this.#s = t.itemHeight),
        (this.#e = t?.gap || 20),
        (this.#h = t?.redundancy ?? 1),
        (this.#t.width = this.#t.clientWidth),
        (this.#t.height = this.#t.clientHeight));
    }
    draw(t) {
      return this.loadImages(t.items)
        .then((s) => this.setImagesPosition(s))
        .then((s) => ((this.#a = s), s))
        .then((s) => this.render(s))
        .catch((s) => {
          (console.error(s), this.onError(s));
        });
    }
    destroy() {
      this.#c.disconnect();
    }
    async loadImages(t) {
      const s = t.map(
          (i, n) =>
            new Promise((d, m) => {
              const c = new Image();
              ((c.onload = () => {
                d({ image: c, index: n });
              }),
                (c.onerror = () => {
                  m(new Error(`failed to load: ${i}`));
                }),
                (c.src = i));
            }),
        ),
        e = await Promise.allSettled(s),
        r = e.filter((i) => i.status === "rejected");
      if (r.length > 0) {
        const i = r.map((n) => n.reason);
        return Promise.reject(i);
      }
      const a = e.filter((i) => i.status === "fulfilled").map((i) => i.value);
      return (
        a.sort((i, n) => i.index - n.index),
        Promise.resolve(a.map((i) => i.image))
      );
    }
    setImagesPosition(t) {
      const s = this.capacityY + 2 * this.#h,
        e = this.capacityX + 2 * this.#h,
        r = [];
      for (let h = 0; h < s * e; h++) {
        const a = h % e,
          i = Math.floor(h / e),
          n = a * (this.#i + this.#e),
          d = i * (this.#s + this.#e);
        r.push({ image: t[h % t.length], x: n, y: d });
      }
      return r;
    }
    bindEvent() {
      (this.#t.addEventListener("mousedown", () => {
        this.#n = !0;
      }),
        this.#t.addEventListener("mouseup", () => {
          this.#n = !1;
        }),
        this.#t.addEventListener("mouseleave", () => {
          this.#n = !1;
        }),
        this.#t.addEventListener("mousemove", (t) => {
          this.#n && this.move(t.movementX, t.movementY);
        }),
        this.#c.observe(this.#t));
    }
    move(t, s) {
      (this.#r?.clearRect(0, 0, this.canvasWidth, this.canvasHeight),
        this.#a.forEach((e) => {
          ((e.x += t),
            e.x > this.rangeWidth - this.#i &&
              (e.x -= this.rangeWidth + this.#e),
            e.x < -this.#i && (e.x += this.rangeWidth + this.#e),
            (e.y += s),
            e.y > this.rangeHeight - this.#s &&
              (e.y -= this.rangeHeight + this.#e),
            e.y < -this.#s && (e.y += this.rangeHeight + this.#e),
            this.#r?.drawImage(e.image, e.x, e.y, this.#i, this.#s));
        }));
    }
    resize() {
      const t = this.#r?.getTransform();
      ((this.#t.width = this.#t.clientWidth),
        (this.#t.height = this.#t.clientHeight),
        console.log("resize handle"),
        t && this.#r?.setTransform(t),
        this.#a.length > 0 && this.render(this.#a));
    }
    render(t) {
      const s = this.#i,
        e = this.#s;
      for (let r = 0; r < t.length; r++) {
        const { image: h, x: a, y: i } = t[r];
        this.#r?.drawImage(h, a, i, s, e);
      }
    }
  }
  return (
    (o.Masonry = g),
    Object.defineProperty(o, Symbol.toStringTag, { value: "Module" }),
    o
  );
})({});
