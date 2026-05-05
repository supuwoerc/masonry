# Builder & Configuration Validation

> This document covers the `MasonryBuilder` fluent API, TypeScript type system, generic validation framework, and environment detection mechanisms.

## Module Position

The Builder is the user's entry point to the library. It encapsulates complex configuration logic, provides a type-safe fluent API, and performs unified validation at build time.

## Source Files

| File | Responsibility |
|------|---------------|
| `src/core/builder.ts` | Fluent builder |
| `src/core/types.ts` | Core type definitions |
| `src/core/rules.ts` | Validation rule set |
| `src/core/constant.ts` | Default configurations |
| `src/core/error.ts` | Error class |
| `src/helper/validator.ts` | Generic validation framework |
| `src/utils/is.ts` | Enhanced type checking |
| `src/utils/canvas.ts` | Environment capability detection |

---

## 1. MasonryBuilder Fluent API

### 1.1 Design Philosophy

Configuration is split into 5 dimensions by **concern**:

| Method | Dimension | Corresponding Type |
|--------|-----------|-------------------|
| `withCore()` | Canvas, style, data source, layout mode | `Core` |
| `withInteraction()` | Click callback, scroll config | `Interaction` |
| `withLoader()` | Infinite scroll pagination | `LoadMoreConfig` |
| `withPlaceholder()` | Placeholder renderer | `PlaceholderRenderer` |
| `withEvents()` | Lifecycle callbacks | `{ onReady, onError }` |

### 1.2 Default Value Merging Strategy

Each `with*` method uses **shallow spread** merging:

```typescript
withCore(config: MasonryConfiguration['core']) {
  this.#config.core = {
    backgroundColor: '#fff',       // default white background
    ...(this.#config.core || {}),   // preserve previously set values
    ...config,                      // user's new values override
  }
  return this
}
```

`build()` uses `lodash.merge` for deep merging, ensuring nested objects are correctly fused.

### 1.3 Build Flow

```
withCore() → withInteraction() → withLoader() → ... → build()
                                                         │
                                        ┌────────────────▼────────────────┐
                                        │ 1. lodash.merge deep merge      │
                                        │ 2. Validator.validate(config)   │
                                        │ 3. Valid → new Masonry(config)  │
                                        │ 4. Invalid → throw MasonryError │
                                        └─────────────────────────────────┘
```

---

## 2. TypeScript Type System

### 2.1 Core Type Hierarchy

```typescript
// Layout mode
type LayoutMode = 'grid' | 'masonry'

// Grid item style
interface GridItemStyle {
  width: number     // Item width (px)
  height: number    // Item height (px)
  radius?: number   // Border radius (px)
  gap?: number      // Gap between items (px)
}

// Image resource descriptor
interface ItemDescriptor {
  url: string       // Image URL
  width?: number    // Original width (for masonry aspect ratio)
  height?: number   // Original height
}

// Core configuration
interface Core {
  canvas: HTMLCanvasElement
  backgroundColor?: string | GradientBackground
  items?: ImageBitmap[] | string[] | ItemDescriptor[]
  style: GridItemStyle
  layout?: LayoutMode
}
```

### 2.2 Data Source Polymorphism

`items` supports three input formats for flexibility:

| Format | Use Case |
|--------|----------|
| `ImageBitmap[]` | Pre-loaded bitmaps, transferred directly to Worker |
| `string[]` | URL string array, library loads automatically |
| `ItemDescriptor[]` | URL + original dimensions, enables pre-calculated heights for masonry |

### 2.3 Extension Interfaces

`PlaceholderRenderer` and `LayoutStrategy` are two core extension points:

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

## 3. Generic Validation Framework

### 3.1 Validator Design (`src/helper/validator.ts`)

`Validator<T>` is a generic validator that accepts an array of rules:

```typescript
class Validator<T extends object> {
  constructor(private rules: Rule<T>[]) {}
  validate(target: T): ValidateResult { ... }
}
```

### 3.2 Rule Interface

```typescript
interface Rule<T> {
  key: keyof T | string  // Supports nested paths like 'core.style.width'
  required?: boolean     // Whether field is required
  type?: CheckableType   // Expected type
  min?: number           // Minimum value/length
  max?: number           // Maximum value/length
  pattern?: RegExp       // Regex match
  enum?: any[]           // Enumerated values
  validate?: (value, obj) => boolean  // Custom validation
  message: string        // Error message
  allowEmpty?: boolean   // Whether empty values are allowed
}
```

### 3.3 Validation Execution Order

```
For each Rule:
  1. required check → missing value reports error and continues
  2. Skip null/undefined/allowEmpty
  3. type check → type mismatch reports error
  4. min/max check → numeric value or array length
  5. pattern check → regex match
  6. enum check → enumeration contains
  7. validate check → custom function
```

Nested path value access uses `lodash.get(target, rule.key)`, supporting deep paths like `'core.style.width'`.

### 3.4 Configuration Rules (`src/core/rules.ts`)

Key validation logic:

| Rule | Meaning |
|------|---------|
| `core` required | Core configuration must be provided |
| `core` validate | Either items or loader must be provided |
| `core.canvas` validate | Must be HTMLCanvasElement instance |
| `core.style.width/height` min:1 | Width/height must be > 0 |
| `core.style.gap/radius` min:0 | Gap and radius cannot be negative |
| `interaction.scroll.friction` | Must be in (0, 1) range |
| `loader.loadMore` validate | Must be a function |

---

## 4. Type Checking Utility

### 4.1 `isTargetType` (`src/utils/is.ts`)

A unified function supporting 15 type checks:

```typescript
type CheckableType =
  | 'string' | 'number' | 'boolean' | 'object' | 'array'
  | 'function' | 'date' | 'regexp' | 'null' | 'undefined'
  | 'plainObject' | 'map' | 'set' | 'symbol' | 'bigint'
```

Special handling:
- `number` excludes `NaN` (`isNumber(value) && !isNaN(value)`)
- `object` excludes array, date, regexp

### 4.2 Dependencies

```
Validator → isTargetType (type checking)
         → lodash.get (nested path access)
         → @supuwoerc/toolkit.isDefined (defined check)
```

---

## 5. Environment Capability Detection

### 5.1 Three-Layer Detection (`src/utils/canvas.ts`)

| Function | What it detects | Purpose |
|----------|----------------|---------|
| `isCanvasSupported()` | Canvas 2D API | Basic requirement |
| `isWorkerSupported()` | Web Worker availability | Decides whether to use Worker |
| `isOffscreenCanvasSupported()` | transferControlToOffscreen | Advanced feature detection |

### 5.2 Real Worker Availability Testing

Not just checking if `Worker` exists, but actually creating one to verify:

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

This is because some restricted environments (e.g., iframe sandbox) declare `Worker` but cannot actually create one.

---

## 6. Error Handling

### 6.1 MasonryError (`src/core/error.ts`)

Extends `Error`, sets `name = 'MasonryError'`, fixes prototype chain:

```typescript
Object.setPrototypeOf(this, MasonryError.prototype)
```

**Why fix the prototype chain**: When TypeScript compiles to ES5, inheriting built-in classes loses prototype methods. `setPrototypeOf` ensures `instanceof MasonryError` works correctly.

### 6.2 Error Propagation Paths

```
Config errors  → MasonryBuilder.build() throws MasonryError
Env errors     → Masonry constructor throws MasonryError
Worker errors  → Worker sends Error message → Main calls onError callback
Loading errors → ImageLoader silently skips / onError callback
```
