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

Each `with*` method uses **shallow spread** merging. Here is the complete implementation of all methods:

```typescript
// src/core/builder.ts
withCore(config: MasonryConfiguration['core']) {
  this.#config.core = {
    backgroundColor: '#fff',       // Default white background to avoid transparent canvas
    ...(this.#config.core || {}),   // Preserve previously set values (supports multiple calls)
    ...config,                      // User's new values override
  }
  return this
}

withInteraction(config: MasonryConfiguration['interaction']) {
  this.#config.interaction = {
    scroll: {
      disabled: { horizontal: false, vertical: false },  // Both scroll directions enabled by default
      inertia: true,                                      // Inertia scrolling enabled by default
    },
    ...(this.#config.interaction || {}),
    ...config,
  }
  return this
}

withLoader(config: MasonryConfiguration['loader']) {
  this.#config.loader = {
    pageSize: 10,                    // Default 10 items per page
    // Fail-loud pattern: if user forgets to provide loadMore, it throws immediately on first trigger
    // instead of silently failing
    loadMore: () => Promise.reject(new MasonryError('loadMore must be a function')),
    ...(this.#config.loader || {}),
    ...config,
  }
  return this
}

withPlaceholder(config: MasonryConfiguration['placeholderRenderer']) {
  // If null/undefined is passed, use the default breathing animation renderer
  this.#config.placeholderRenderer = config ?? new BreathingPlaceholderRenderer()
  return this
}

withEvents(config: MasonryConfiguration['events']) {
  this.#config.events = {
    onError: (e) => console.error(e),  // Default error handling: print to console
    ...(this.#config.events || {}),
    ...config,
  }
  return this
}
```

**Design Notes**:

- **`loadMore` fail-loud default**: Uses `Promise.reject` instead of `() => []` as default. If a user configures `withLoader` but forgets to provide a `loadMore` function, it throws immediately on first trigger rather than silently returning an empty array — making the misconfiguration obvious instead of creating subtle bugs.
- **Shallow spread + return `this`**: Enables chaining and allows calling the same `with*` method multiple times (latter overrides former for same-name properties).
- **`build()` uses `lodash.merge` for deep merging**: Ensures nested objects (like `scroll.disabled`) aren't completely replaced by shallow copy.

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

Complete implementation of the `build()` method:

```typescript
// src/core/builder.ts
build(): Masonry {
  // The argument order of merge({ core: this.#config.core! }, this.#config) is critical:
  // First argument { core } serves as base object, ensuring core field always exists
  // Second argument this.#config is deep-merged into the base via lodash.merge
  // This ensures even nested core sub-properties set by other methods are correctly fused
  const config = merge({ core: this.#config.core! }, this.#config)

  // Builder-level validation
  const { valid, errors } = this.#validator.validate(config)
  if (!valid) {
    throw new MasonryError(errors.join('\n'))
  }

  // Create Masonry instance (Masonry constructor validates again internally — double insurance)
  return new Masonry(config)
}
```

**Design Notes**:

- **Double validation strategy**: Both Builder and Masonry constructor perform validation. This is because Masonry can be created directly via `new Masonry(config)` bypassing the Builder — the constructor's validation ensures config is always valid regardless of creation path.
- **Why the first argument to `merge` is `{ core: this.#config.core! }`**: Ensures the merge target contains the core field. If using `merge({}, this.#config)` directly, when `#config.core` is a reference set via `withCore`, merge would mutate the original reference object (lodash.merge is mutative), potentially causing issues in subsequent calls.

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

Complete implementation of `Validator.validate()`, demonstrating the clear priority chain and short-circuit logic:

```typescript
// src/helper/validator.ts
validate(target: T): ValidateResult {
  const errors: string[] = []
  for (const rule of this.rules) {
    // Use lodash.get to support nested path access, e.g., 'core.style.width'
    const value = get(target, rule.key)

    // Priority 1: required check
    // Required field missing or null → report error and continue (skip subsequent checks)
    if (rule.required && (!isDefined(value) || isNull(value))) {
      errors.push(`rule.required:${rule.message}`)
      continue
    }

    // Skip condition: value undefined, null, or allowEmpty is true and value is empty
    // Critical: allowEmpty skip does NOT apply to number/boolean types
    // Reason: 0 and false are valid numeric/boolean values, not "empty"
    if (
      !isDefined(value) ||
      isNull(value) ||
      (rule.allowEmpty && !isNumber(value) && !isBoolean(value) && isEmpty(value))
    ) {
      continue
    }

    // Priority 2: type check
    if (rule.type && !this.#checkType(value, rule.type)) {
      errors.push(`rule.type:${rule.message}`)
      continue
    }

    // Priority 3: min/max check (works for both numbers and array lengths)
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

    // Priority 4: pattern regex check
    if (rule.pattern && !rule.pattern.test(String(value))) {
      errors.push(`rule.pattern:${rule.message}`)
      continue
    }

    // Priority 5: enum check
    if (rule.enum && !rule.enum.includes(value)) {
      errors.push(`rule.enum:${rule.message}`)
      continue
    }

    // Priority 6: custom validate function (most flexible, executed last)
    if (rule.validate && !rule.validate(value, target)) {
      errors.push(`rule.validate:${rule.message}`)
    }
  }
  return { valid: errors.length === 0, errors }
}
```

**Design Notes**:

- **`continue` short-circuit pattern**: After each priority check fails, `continue` skips remaining checks for that rule. For example, if type check fails, min/max checks are meaningless for the invalid value.
- **`allowEmpty` special handling for number/boolean**: `isEmpty(0)` and `isEmpty(false)` return `true` in lodash, but 0 and false are legitimate config values (e.g., `gap: 0`, `disabled: false`), so these types must be excluded from the empty check.
- **Error prefix format** (`rule.required:`, `rule.type:`, etc.): Error messages include which rule type triggered them, making it easy to pinpoint which validation step failed during debugging.

### 3.4 Configuration Rules (`src/core/rules.ts`)

Here is the complete rule set, demonstrating various validation pattern combinations:

```typescript
// src/core/rules.ts
export const configurationRules: Rule<MasonryConfiguration>[] = [
  // ─── Core configuration ───
  {
    key: 'core',
    required: true,                            // Required: cannot initialize without core config
    message: 'core configuration missing',
  },
  {
    key: 'core',
    validate: (core, config) => {
      const hasItems = core.items && core.items.length > 0
      const hasLoader = !!config.loader
      return hasItems || hasLoader             // At least one data source
    },
    message: 'either items or loader must be provided',
  },
  // Note: same key has two rules — required checks existence, validate checks business logic
  // This "dual-rule pattern" produces more precise error messages

  // ─── Canvas element ───
  {
    key: 'core.canvas',
    required: true,
    validate: (canvas) => canvas instanceof HTMLCanvasElement,  // Rejects OffscreenCanvas or other elements
    message: 'invalid canvas element',
  },

  // ─── Data items ───
  {
    key: 'core.items',
    required: false,
    type: 'array',
    min: 1,
    message: 'items must be an array containing at least one element',
    allowEmpty: true,     // Allow omitting items (when using loader mode)
  },

  // ─── Style dimensions ───
  {
    key: 'core.style.width',
    required: true,
    type: 'number',
    min: 1,               // Width must be > 0, otherwise layout calculation divides by zero
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
    min: 0,               // Gap can be 0 (tight layout) but cannot be negative
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

  // ─── Interaction configuration ───
  {
    key: 'interaction.onClick',
    // Pattern: !isDefined(v) || isFunction(v)
    // Meaning: either don't provide it (undefined), or it must be a function. Non-function values rejected
    validate: (v) => !isDefined(v) || isFunction(v),
    message: 'onClick must be a function',
    allowEmpty: true,
  },
  {
    key: 'interaction.scroll.friction',
    type: 'number',
    // Uses custom validate instead of min/max because:
    // friction needs open interval (0, 1), while min/max is closed interval [min, max]
    validate: (v) => !isDefined(v) || (v > 0 && v < 1),
    message: 'friction must be a number between 0 and 1 (exclusive)',
    allowEmpty: true,
  },

  // ─── Loader configuration ───
  {
    key: 'loader.pageSize',
    type: 'number',
    min: 1,
    message: 'pageSize must be a positive integer',
  },
  {
    key: 'loader.loadMore',
    validate: (v) => isFunction(v),            // loadMore must be a function, no "optional" semantics
    message: 'loadMore must be a function',
  },

  // ─── Event callbacks ───
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

**Design Notes**:

- **`!isDefined(v) || isFunction(v)` idiom**: Used for "optional function" scenarios. Not providing it (undefined) is valid; if provided, it must be a function. Prevents users from mistakenly passing `onClick: "handler"` as a string.
- **Why `friction` doesn't use min/max**: min/max implements closed interval `[min, max]`, but friction of 0 means the object never decelerates (meaningless), and 1 means instant stop (also meaningless) — open interval `(0, 1)` is required.
- **Same-key dual-rule pattern**: `core` has two rules — first checks existence, second checks business logic. This produces more precise errors: user omitting core entirely gets "missing", while providing core without a data source gets "either items or loader".

---

## 4. Type Checking Utility

### 4.1 `isTargetType` (`src/utils/is.ts`)

A unified function supporting 15 type checks, complete implementation:

```typescript
// src/utils/is.ts
export function isTargetType(value: any, type: CheckableType): boolean {
  switch (type) {
    case 'string':
      return isString(value)
    case 'number':
      // Excludes NaN: NaN is typeof 'number', but is never a valid config value
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
      // Excludes array/date/regexp: although typeof is 'object' for these,
      // in config validation context, 'object' typically means a plain object, not special built-ins
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
      // Exhaustiveness check: if a new CheckableType is added but not handled in switch,
      // it throws immediately at runtime instead of returning false causing silent validation failure
      throw new Error(`Unsupported type checking: ${type}`)
  }
}
```

**Design Notes**:

- **`number` excludes NaN**: `typeof NaN === 'number'` is a JavaScript legacy quirk. In config validation, NaN is never a valid value (e.g., `width: NaN`) and must be treated as a type mismatch.
- **`object` excludes special types**: When a user passes `style: new Date()` or `style: [1,2,3]`, the type:'object' check should catch these misuses.
- **`default` throws error**: This is a runtime complement to TypeScript's exhaustiveness checking. If the `CheckableType` union gains new members but the switch isn't updated, TS may not report an error at compile time (depending on config), but runtime will immediately expose the issue.

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

### 5.2 Complete Implementation and Design Reasoning

```typescript
// src/utils/canvas.ts

/**
 * Canvas API detection: creates an actual canvas element and obtains a context
 */
function isCanvasSupported(): boolean {
  if (!isDefined(HTMLCanvasElement)) {
    return false
  }
  // Not just checking if the class exists, but verifying a 2D context can be created
  // Some headless environments declare HTMLCanvasElement but getContext returns null
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  return !!(canvas && context)
}

/**
 * Worker availability detection: creates an actual Worker instance
 */
function isWorkerSupported(): boolean {
  if (!isDefined(window) || !isDefined(Worker)) {
    return false
  }
  try {
    // Why create a real Worker instead of just checking typeof Worker !== 'undefined':
    // 1. iframe sandbox environments may declare the Worker constructor but prohibit creation
    // 2. CSP (Content-Security-Policy) may block Blob URL Workers
    // 3. Some browser extensions or enterprise policies intercept Worker creation
    const blob = new Blob([''], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    const worker = new Worker(url)
    URL.revokeObjectURL(url)   // Immediately release Blob URL to prevent memory leak
    worker.terminate()          // Immediately terminate test Worker
    return true
  } catch {
    return false
  }
}

/**
 * OffscreenCanvas detection: verifies the complete transferControlToOffscreen chain
 */
function isOffscreenCanvasSupported(): boolean {
  if (!isDefined(HTMLCanvasElement)) {
    return false
  }
  // First check if the prototype method exists
  if (!isFunction(HTMLCanvasElement.prototype.transferControlToOffscreen)) {
    return false
  }
  try {
    // Actually call transferControlToOffscreen and verify the return value
    const canvas = document.createElement('canvas')
    const offscreen = canvas.transferControlToOffscreen()
    // Double verification: 1. Valid object returned 2. OffscreenCanvas global class exists
    // Some polyfills may implement transferControlToOffscreen without a complete OffscreenCanvas class
    return !!offscreen && typeof OffscreenCanvas !== 'undefined'
  } catch {
    return false
  }
}
```

**Design Notes**:

- **"Create to verify" principle**: All three functions don't just check if APIs are declared — they perform actual operations to verify functionality. Modern browser environments are complex (CSP, sandboxes, polyfills); declaration existence doesn't guarantee usability.
- **`isWorkerSupported` cleanup**: The test Worker is immediately `terminate()`d and the Blob URL is released, ensuring detection leaves no side effects.
- **Usage timing**: `isCanvasSupported()` is called at the very beginning of the Masonry constructor (throws if unsupported), `isWorkerSupported()` determines whether to initialize a Worker (reports error via onError if unsupported).

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
