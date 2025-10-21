export type f = (...args: unknown[]) => unknown

export function isFunction(val: unknown): val is f {
  return typeof val === 'function'
}
