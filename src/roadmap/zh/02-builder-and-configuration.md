# Builder 构建器与配置验证

> 本文档介绍 `MasonryBuilder` 链式 API、TypeScript 类型系统、通用验证框架和环境检测机制。

## 模块定位

Builder 是用户使用本库的入口。它封装了复杂的配置逻辑，提供类型安全的链式 API，并在构建时统一执行验证。

## 涉及源文件

| 文件 | 职责 |
|------|------|
| `src/core/builder.ts` | 链式构建器 |
| `src/core/types.ts` | 核心类型定义 |
| `src/core/rules.ts` | 验证规则集合 |
| `src/core/constant.ts` | 默认配置 |
| `src/core/error.ts` | 错误类 |
| `src/helper/validator.ts` | 通用验证框架 |
| `src/utils/is.ts` | 增强类型检查 |
| `src/utils/canvas.ts` | 环境能力检测 |

---

## 1. MasonryBuilder 链式 API

### 1.1 设计理念

配置项按**关注点**拆分为 5 个维度：

| 方法 | 配置维度 | 对应类型 |
|------|---------|---------|
| `withCore()` | 画布、样式、数据源、布局模式 | `Core` |
| `withInteraction()` | 点击回调、滚动配置 | `Interaction` |
| `withLoader()` | 无限滚动分页配置 | `LoadMoreConfig` |
| `withPlaceholder()` | 占位符渲染器 | `PlaceholderRenderer` |
| `withEvents()` | 生命周期回调 | `{ onReady, onError }` |

### 1.2 默认值合并策略

每个 `with*` 方法采用**浅扩展**合并，以下是各方法的完整实现：

```typescript
// src/core/builder.ts
withCore(config: MasonryConfiguration['core']) {
  this.#config.core = {
    backgroundColor: '#fff',       // 默认白色背景，避免画布透明
    ...(this.#config.core || {}),   // 保留之前设置的值（支持多次调用）
    ...config,                      // 用户新值覆盖
  }
  return this
}

withInteraction(config: MasonryConfiguration['interaction']) {
  this.#config.interaction = {
    scroll: {
      disabled: { horizontal: false, vertical: false },  // 默认双向滚动都启用
      inertia: true,                                      // 默认开启惯性滚动
    },
    ...(this.#config.interaction || {}),
    ...config,
  }
  return this
}

withLoader(config: MasonryConfiguration['loader']) {
  this.#config.loader = {
    pageSize: 10,                    // 默认每页 10 条
    // fail-loud 模式：如果用户忘记提供 loadMore，调用时会立即抛错而非静默失败
    loadMore: () => Promise.reject(new MasonryError('loadMore must be a function')),
    ...(this.#config.loader || {}),
    ...config,
  }
  return this
}

withPlaceholder(config: MasonryConfiguration['placeholderRenderer']) {
  // 如果传入 null/undefined，使用默认的呼吸动画渲染器
  this.#config.placeholderRenderer = config ?? new BreathingPlaceholderRenderer()
  return this
}

withEvents(config: MasonryConfiguration['events']) {
  this.#config.events = {
    onError: (e) => console.error(e),  // 默认错误处理：打印到控制台
    ...(this.#config.events || {}),
    ...config,
  }
  return this
}
```

**设计要点**：

- **`loadMore` 的 fail-loud 默认值**：用 `Promise.reject` 而非 `() => []` 作为默认值。这样如果用户配置了 `withLoader` 但忘记提供 `loadMore` 函数，会在首次触发时立即报错，而非静默返回空数组导致加载行为异常难以排查。
- **浅扩展 + 返回 `this`**：支持链式调用且允许多次调用同一个 `with*` 方法（后者覆盖前者的同名属性）。
- **`build()` 时使用 `lodash.merge` 做深合并**：确保嵌套对象（如 `scroll.disabled`）不会被浅拷贝完全替换。

### 1.3 构建流程

```
withCore() → withInteraction() → withLoader() → ... → build()
                                                         │
                                        ┌────────────────▼────────────────┐
                                        │ 1. lodash.merge 深合并配置       │
                                        │ 2. Validator.validate(config)   │
                                        │ 3. 验证通过 → new Masonry(config)│
                                        │ 4. 验证失败 → throw MasonryError │
                                        └─────────────────────────────────┘
```

`build()` 方法的完整实现：

```typescript
// src/core/builder.ts
build(): Masonry {
  // merge({ core: this.#config.core! }, this.#config) 的顺序很关键：
  // 第一个参数 { core } 作为 base 对象，确保 core 字段一定存在
  // 第二个参数 this.#config 用 lodash.merge 深度合并进 base
  // 这样即使用户调用了 withCore 和其他方法设置了嵌套的 core 子属性，也能正确融合
  const config = merge({ core: this.#config.core! }, this.#config)

  // Builder 层面执行一次验证
  const { valid, errors } = this.#validator.validate(config)
  if (!valid) {
    throw new MasonryError(errors.join('\n'))
  }

  // 创建 Masonry 实例（Masonry 构造函数内部会再次验证——双重保险）
  return new Masonry(config)
}
```

**设计要点**：

- **双重验证策略**：Builder 和 Masonry 构造函数各执行一次验证。这是因为 Masonry 可以绕过 Builder 直接 `new Masonry(config)` 创建，构造函数内的验证保证了无论创建路径如何，配置都是合法的。
- **`merge` 的第一个参数为何是 `{ core: this.#config.core! }`**：确保 merge 的目标对象包含 core 字段。如果直接 `merge({}, this.#config)`，当 `#config.core` 是通过 `withCore` 设置的引用时，merge 会修改原始引用对象（lodash.merge 是 mutative 的），可能导致后续调用出问题。

---

## 2. TypeScript 类型系统

### 2.1 核心类型层次

```typescript
// 布局模式
type LayoutMode = 'grid' | 'masonry'

// 网格项样式
interface GridItemStyle {
  width: number     // 项目宽度（px）
  height: number    // 项目高度（px）
  radius?: number   // 圆角（px）
  gap?: number      // 间距（px）
}

// 图片资源描述
interface ItemDescriptor {
  url: string       // 图片 URL
  width?: number    // 原始宽度（瀑布流计算宽高比）
  height?: number   // 原始高度
}

// 核心配置
interface Core {
  canvas: HTMLCanvasElement
  backgroundColor?: string | GradientBackground
  items?: ImageBitmap[] | string[] | ItemDescriptor[]
  style: GridItemStyle
  layout?: LayoutMode
}
```

### 2.2 数据源多态

`items` 支持三种输入格式，体现灵活性：

| 格式 | 适用场景 |
|------|---------|
| `ImageBitmap[]` | 已预加载好的位图，直接传入 Worker |
| `string[]` | URL 字符串数组，库自动加载 |
| `ItemDescriptor[]` | URL + 原始尺寸，瀑布流布局时可提前计算高度 |

### 2.3 扩展接口

`PlaceholderRenderer` 和 `LayoutStrategy` 是两个核心扩展点：

```typescript
interface PlaceholderRenderer {
  render: (width: number, height: number, id: string) => ImageBitmap | Promise<ImageBitmap>
  dispose: () => void
  remove: (id: string) => void
}

interface LayoutStrategy {
  calculate: (input: LayoutInput) => LayoutResult
}
```

---

## 3. 通用验证框架

### 3.1 验证器设计（`src/helper/validator.ts`）

`Validator<T>` 是一个泛型验证器，接收规则数组：

```typescript
class Validator<T extends object> {
  constructor(private rules: Rule<T>[]) {}
  validate(target: T): ValidateResult { ... }
}
```

### 3.2 Rule 接口

```typescript
interface Rule<T> {
  key: keyof T | string  // 支持嵌套路径如 'core.style.width'
  required?: boolean     // 是否必填
  type?: CheckableType   // 期望类型
  min?: number           // 最小值/最小长度
  max?: number           // 最大值/最大长度
  pattern?: RegExp       // 正则匹配
  enum?: any[]           // 枚举值
  validate?: (value, obj) => boolean  // 自定义验证
  message: string        // 错误信息
  allowEmpty?: boolean   // 是否允许空值
}
```

### 3.3 验证执行顺序

`Validator.validate()` 的完整实现，体现了清晰的优先级链和短路逻辑：

```typescript
// src/helper/validator.ts
validate(target: T): ValidateResult {
  const errors: string[] = []
  for (const rule of this.rules) {
    // 使用 lodash.get 支持嵌套路径取值，如 'core.style.width'
    const value = get(target, rule.key)

    // 优先级 1：required 检查
    // 必填字段不存在或为 null 时，直接报错并 continue（跳过后续检查）
    if (rule.required && (!isDefined(value) || isNull(value))) {
      errors.push(`rule.required:${rule.message}`)
      continue
    }

    // 跳过条件：值未定义、为 null、或 allowEmpty 为 true 且值为空
    // 关键：allowEmpty 跳过不适用于 number/boolean 类型
    // 原因：0 和 false 是有效的数值/布尔值，不应被视为"空"
    if (
      !isDefined(value) ||
      isNull(value) ||
      (rule.allowEmpty && !isNumber(value) && !isBoolean(value) && isEmpty(value))
    ) {
      continue
    }

    // 优先级 2：type 检查
    if (rule.type && !this.#checkType(value, rule.type)) {
      errors.push(`rule.type:${rule.message}`)
      continue
    }

    // 优先级 3：min/max 检查（对数字和数组长度都有效）
    if (rule.min !== undefined) {
      if (isNumber(value) && value < rule.min) {
        errors.push(`rule.min:${rule.message}`)
        continue
      }
      if (isArray(value) && value.length < rule.min) {
        errors.push(`rule.min:${rule.message}`)
        continue
      }
    }
    if (rule.max !== undefined) {
      if (isNumber(value) && value > rule.max) {
        errors.push(`rule.max:${rule.message}`)
        continue
      }
      if (isArray(value) && value.length > rule.max) {
        errors.push(`rule.max:${rule.message}`)
        continue
      }
    }

    // 优先级 4：pattern 正则检查
    if (rule.pattern && !rule.pattern.test(String(value))) {
      errors.push(`rule.pattern:${rule.message}`)
      continue
    }

    // 优先级 5：enum 枚举检查
    if (rule.enum && !rule.enum.includes(value)) {
      errors.push(`rule.enum:${rule.message}`)
      continue
    }

    // 优先级 6：自定义 validate 函数（最灵活，也最后执行）
    if (rule.validate && !rule.validate(value, target)) {
      errors.push(`rule.validate:${rule.message}`)
    }
  }
  return { valid: errors.length === 0, errors }
}
```

**设计要点**：

- **`continue` 短路模式**：每个优先级检查失败后 `continue`，避免对已知非法值执行后续无意义的检查。例如 type 检查失败后，min/max 检查已无意义。
- **`allowEmpty` 与 number/boolean 的特殊处理**：`isEmpty(0)` 和 `isEmpty(false)` 在 lodash 中返回 `true`，但 0 和 false 是合法的配置值（如 `gap: 0`、`disabled: false`），所以必须排除这两种类型。
- **错误前缀格式** (`rule.required:`, `rule.type:` 等)：错误信息包含触发的规则类型，便于调试时快速定位是哪个验证环节失败。

### 3.4 配置验证规则（`src/core/rules.ts`）

以下是完整的规则集合，展示了各种验证模式的组合使用：

```typescript
// src/core/rules.ts
export const configurationRules: Rule<MasonryConfiguration>[] = [
  // ─── core 配置 ───
  {
    key: 'core',
    required: true,                            // 必填：核心配置缺失则无法初始化
    message: 'core configuration missing',
  },
  {
    key: 'core',
    validate: (core, config) => {
      const hasItems = core.items && core.items.length > 0
      const hasLoader = !!config.loader
      return hasItems || hasLoader             // 至少一个数据来源
    },
    message: 'either items or loader must be provided',
  },
  // 注意：同一个 key 有两条规则——required 检查存在性，validate 检查业务逻辑
  // 这种"双规则模式"让错误信息更精确

  // ─── canvas 元素 ───
  {
    key: 'core.canvas',
    required: true,
    validate: (canvas) => canvas instanceof HTMLCanvasElement,  // 不接受 OffscreenCanvas 或其他元素
    message: 'invalid canvas element',
  },

  // ─── 数据项 ───
  {
    key: 'core.items',
    required: false,
    type: 'array',
    min: 1,
    message: 'items must be an array containing at least one element',
    allowEmpty: true,     // 允许不传 items（使用 loader 模式时）
  },

  // ─── 样式尺寸 ───
  {
    key: 'core.style.width',
    required: true,
    type: 'number',
    min: 1,               // 宽度必须 > 0，否则布局计算会除以零
    message: 'the width must be a number greater than 0',
  },
  {
    key: 'core.style.height',
    required: true,
    type: 'number',
    min: 1,
    message: 'the height must be a number greater than 0',
  },
  {
    key: 'core.style.gap',
    type: 'number',
    min: 0,               // 间距可以为 0（紧密排列），但不能为负
    message: 'The spacing must be a non-negative number',
    allowEmpty: true,
  },
  {
    key: 'core.style.radius',
    type: 'number',
    min: 0,
    message: 'The radius of the fillet must be a non-negative number',
    allowEmpty: true,
  },

  // ─── 交互配置 ───
  {
    key: 'interaction.onClick',
    // 模式：!isDefined(v) || isFunction(v)
    // 含义：要么不传（undefined），要么必须是函数。不允许传非函数值
    validate: (v) => !isDefined(v) || isFunction(v),
    message: 'onClick must be a function',
    allowEmpty: true,
  },
  {
    key: 'interaction.scroll.friction',
    type: 'number',
    // 使用自定义 validate 而非 min/max 的原因：
    // friction 需要 (0, 1) 开区间，而 min/max 是 [min, max] 闭区间
    validate: (v) => !isDefined(v) || (v > 0 && v < 1),
    message: 'friction must be a number between 0 and 1 (exclusive)',
    allowEmpty: true,
  },

  // ─── 加载配置 ───
  {
    key: 'loader.pageSize',
    type: 'number',
    min: 1,
    message: 'pageSize must be a positive integer',
  },
  {
    key: 'loader.loadMore',
    validate: (v) => isFunction(v),            // loadMore 必须是函数，无 "可选" 语义
    message: 'loadMore must be a function',
  },

  // ─── 事件回调 ───
  {
    key: 'events.onReady',
    validate: (v) => !isDefined(v) || isFunction(v),
    message: 'onReady must be a function',
    allowEmpty: true,
  },
  {
    key: 'events.onError',
    validate: (v) => !isDefined(v) || isFunction(v),
    message: 'onError must be a function',
    allowEmpty: true,
  },
]
```

**设计要点**：

- **`!isDefined(v) || isFunction(v)` 惯用法**：用于"可选函数"场景。不传（undefined）是合法的，传了就必须是函数。这避免了用户误传 `onClick: "handler"` 这样的字符串。
- **`friction` 为何不用 min/max**：min/max 实现的是闭区间 `[min, max]`，但摩擦系数为 0 时物体不会减速（无意义），为 1 时物体瞬间停止（也无意义），需要开区间 `(0, 1)`。
- **同 key 双规则模式**：`core` 有两条规则——第一条检查存在性，第二条检查业务逻辑。这让错误信息更精确：用户完全不传 core 时得到 "missing"，传了但没有数据源时得到 "either items or loader"。

---

## 4. 类型检查工具

### 4.1 `isTargetType`（`src/utils/is.ts`）

支持 15 种类型检测的统一函数，完整实现：

```typescript
// src/utils/is.ts
export function isTargetType(value: any, type: CheckableType): boolean {
  switch (type) {
    case 'string':
      return isString(value)
    case 'number':
      // 排除 NaN：NaN 在 typeof 中是 'number'，但不是有效的数字配置值
      return isNumber(value) && !isNaN(value)
    case 'boolean':
      return isBoolean(value)
    case 'function':
      return isFunction(value)
    case 'symbol':
      return typeof value === 'symbol'
    case 'bigint':
      return typeof value === 'bigint'
    case 'null':
      return isNull(value)
    case 'undefined':
      return isUndefined(value)
    case 'array':
      return isArray(value)
    case 'object':
      // 排除 array/date/regexp：这些虽然 typeof 也是 'object'，
      // 但在配置验证语境下，'object' 通常指普通对象而非特殊内置类型
      return isObject(value) && !isArray(value) && !isDate(value) && !isRegExp(value)
    case 'plainObject':
      return isPlainObject(value)
    case 'date':
      return isDate(value)
    case 'regexp':
      return isRegExp(value)
    case 'map':
      return value instanceof Map
    case 'set':
      return value instanceof Set
    default:
      // 穷尽性检查：如果新增了 CheckableType 但忘了在 switch 中处理，
      // 运行时会立即报错而非返回 false 导致静默验证失败
      throw new Error(`Unsupported type checking: ${type}`)
  }
}
```

**设计要点**：

- **`number` 排除 NaN**：`typeof NaN === 'number'` 是 JavaScript 的历史遗留问题。在配置验证场景中，NaN 永远不是合法值（如 `width: NaN`），必须视为类型不匹配。
- **`object` 排除特殊类型**：用户传入 `style: new Date()` 或 `style: [1,2,3]`，期望 type:'object' 检查能拦截这些误用。
- **`default` 抛出错误**：这是 TypeScript 穷尽性检查的运行时补充。如果 `CheckableType` 联合类型增加了新成员但 switch 未更新，编译时 TS 可能不报错（取决于配置），但运行时会立即暴露问题。

### 4.2 依赖关系

```
Validator → isTargetType (类型检查)
         → lodash.get (嵌套路径取值)
         → @supuwoerc/toolkit.isDefined (定义性检查)
```

---

## 5. 环境能力检测

### 5.1 三层检测（`src/utils/canvas.ts`）

| 函数 | 检测内容 | 用途 |
|------|---------|------|
| `isCanvasSupported()` | Canvas 2D API | 最基本要求 |
| `isWorkerSupported()` | Web Worker 可用性 | 决定是否使用 Worker |
| `isOffscreenCanvasSupported()` | transferControlToOffscreen | 高级特性检测 |

### 5.2 完整实现与设计思路

```typescript
// src/utils/canvas.ts

/**
 * Canvas API 检测：创建实际的 canvas 元素并获取上下文
 */
function isCanvasSupported(): boolean {
  if (!isDefined(HTMLCanvasElement)) {
    return false
  }
  // 不仅检查类是否存在，还验证能否成功创建 2D 上下文
  // 某些无头环境声明了 HTMLCanvasElement 但 getContext 返回 null
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  return !!(canvas && context)
}

/**
 * Worker 可用性检测：创建一个真实的 Worker 实例
 */
function isWorkerSupported(): boolean {
  if (!isDefined(window) || !isDefined(Worker)) {
    return false
  }
  try {
    // 为什么要创建真实 Worker 而非仅检查 typeof Worker !== 'undefined'：
    // 1. iframe sandbox 环境可能声明了 Worker 构造函数但禁止实际创建
    // 2. CSP (Content-Security-Policy) 可能阻止 Blob URL 的 Worker
    // 3. 某些浏览器扩展或企业策略会拦截 Worker 创建
    const blob = new Blob([''], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    const worker = new Worker(url)
    URL.revokeObjectURL(url)   // 立即释放 Blob URL，避免内存泄漏
    worker.terminate()          // 立即终止测试 Worker
    return true
  } catch {
    return false
  }
}

/**
 * OffscreenCanvas 检测：验证完整的 transferControlToOffscreen 链路
 */
function isOffscreenCanvasSupported(): boolean {
  if (!isDefined(HTMLCanvasElement)) {
    return false
  }
  // 先检查原型方法是否存在
  if (!isFunction(HTMLCanvasElement.prototype.transferControlToOffscreen)) {
    return false
  }
  try {
    // 实际调用 transferControlToOffscreen 并验证返回值
    const canvas = document.createElement('canvas')
    const offscreen = canvas.transferControlToOffscreen()
    // 双重验证：1. 返回了有效对象 2. OffscreenCanvas 全局类存在
    // 某些 polyfill 可能实现了 transferControlToOffscreen 但没有完整的 OffscreenCanvas 类
    return !!offscreen && typeof OffscreenCanvas !== 'undefined'
  } catch {
    return false
  }
}
```

**设计要点**：

- **"创建即验证"原则**：三个函数都不仅检查 API 是否声明存在，还执行实际操作来验证功能可用。这是因为现代浏览器环境复杂（CSP、沙箱、polyfill），声明存在不等于可用。
- **`isWorkerSupported` 的清理**：创建的测试 Worker 会立即 `terminate()` 并释放 Blob URL，确保检测不会留下副作用。
- **使用时机**：`isCanvasSupported()` 在 Masonry 构造函数最前面调用（不支持则直接抛错），`isWorkerSupported()` 决定是否初始化 Worker（不支持则回退报错）。

---

## 6. 错误处理

### 6.1 MasonryError（`src/core/error.ts`）

继承 `Error`，设置 `name = 'MasonryError'`，修复原型链：

```typescript
Object.setPrototypeOf(this, MasonryError.prototype)
```

**为什么修复原型链**：TypeScript 编译到 ES5 时，继承内置类会丢失原型方法。通过 `setPrototypeOf` 确保 `instanceof MasonryError` 正确工作。

### 6.2 错误传播路径

```
配置错误   → MasonryBuilder.build() 抛出 MasonryError
环境错误   → Masonry constructor 抛出 MasonryError
Worker 错误 → Worker 发送 Error 消息 → Main 调用 onError 回调
加载错误   → ImageLoader 静默跳过 / onError 回调
```
