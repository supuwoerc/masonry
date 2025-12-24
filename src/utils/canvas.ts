import { isFunction, isUndefined } from 'lodash-es'

/**
 * 检测当前环境是否支持Canvas API
 * Detects whether the Canvas API is supported in the current environment
 *
 * @returns {boolean} 如果支持Canvas返回true，否则返回false
 *          Returns true if Canvas is supported, otherwise false
 */
export function isCanvasSupported(): boolean {
  if (isUndefined(HTMLCanvasElement)) {
    return false
  }
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  return !!(canvas && context)
}

/**
 * 检测当前环境是否支持Web Worker API
 * Detects whether the Web Worker API is supported in the current environment
 *
 * @returns {boolean} 如果支持Worker返回true，否则返回false
 *          Returns true if Web Worker is supported, otherwise false
 */
export function isWorkerSupported(): boolean {
  if (isUndefined(window) || isUndefined(Worker)) {
    return false
  }
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

/**
 * 检测当前环境是否支持Canvas的transferControlToOffscreen方法
 * Detects whether transferControlToOffscreen method is supported for Canvas
 *
 * @returns {boolean} 如果支持返回true，否则返回false
 *          Returns true if supported, otherwise false
 */
export function isOffscreenCanvasSupported(): boolean {
  if (isUndefined(HTMLCanvasElement)) {
    return false
  }
  if (!isFunction(HTMLCanvasElement.prototype.transferControlToOffscreen)) {
    return false
  }
  try {
    const canvas = document.createElement('canvas')
    const offscreen = canvas.transferControlToOffscreen()
    return !!offscreen && typeof OffscreenCanvas !== 'undefined'
  } catch {
    return false
  }
}
