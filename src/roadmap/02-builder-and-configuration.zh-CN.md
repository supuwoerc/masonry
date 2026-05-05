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

每个 `with*` 方法采用**浅扩展**合并：

```typescript
withCore(config: MasonryConfiguration['core']) {
  this.#config.core = {
    backgroundColor: '#fff',       // 默认白色背景
    ...(this.#config.core || {}),   // 保留之前设置的值
    ...config,                      // 用户新值覆盖
  }
  return this
}
```

`build()` 时使用 `lodash.merge` 做深合并，确保嵌套对象正确融合。

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

```
对每条 Rule:
  1. required 检查 → 不存在则报错并 continue
  2. 跳过 null/undefined/allowEmpty
  3. type 检查 → 类型不匹配则报错
  4. min/max 检查 → 数值或数组长度
  5. pattern 检查 → 正则匹配
  6. enum 检查 → 枚举包含
  7. validate 检查 → 自定义函数
```

嵌套路径取值使用 `lodash.get(target, rule.key)`，支持 `'core.style.width'` 这样的深层路径。

### 3.4 配置验证规则（`src/core/rules.ts`）

关键验证逻辑：

| 规则 | 含义 |
|------|------|
| `core` required | 核心配置必须提供 |
| `core` validate | items 或 loader 至少提供一个 |
| `core.canvas` validate | 必须是 HTMLCanvasElement 实例 |
| `core.style.width/height` min:1 | 宽高必须大于 0 |
| `core.style.gap/radius` min:0 | 间距和圆角不能为负 |
| `interaction.scroll.friction` | 必须在 (0, 1) 区间内 |
| `loader.loadMore` validate | 必须是函数 |

---

## 4. 类型检查工具

### 4.1 `isTargetType`（`src/utils/is.ts`）

支持 15 种类型检测的统一函数：

```typescript
type CheckableType =
  | 'string' | 'number' | 'boolean' | 'object' | 'array'
  | 'function' | 'date' | 'regexp' | 'null' | 'undefined'
  | 'plainObject' | 'map' | 'set' | 'symbol' | 'bigint'
```

特殊处理：
- `number` 排除 `NaN`（`isNumber(value) && !isNaN(value)`）
- `object` 排除 array、date、regexp

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

### 5.2 Worker 可用性的真实检测

不仅检查 `Worker` 是否存在，还真正创建一个 Worker 来验证：

```typescript
function isWorkerSupported(): boolean {
  try {
    const blob = new Blob([''], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    const worker = new Worker(url)
    URL.revokeObjectURL(url)
    worker.terminate()
    return true
  } catch {
    return false
  }
}
```

这是因为某些受限环境（如 iframe sandbox）会声明 `Worker` 但实际无法创建。

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
