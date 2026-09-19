/**
 * 排序配置公共类型和泛型比较器工厂（自 v4 client/quartz/util/sort.ts 移植）
 *
 * 设计原则：
 * - 类型定义统一，各组件共享
 * - 排序比较逻辑只写一次
 * - 各组件通过 getter 函数控制自己的数据访问（QuartzPluginData / FileTrieNode 等）
 */

/**
 * 排序算法类型
 * natural: 自然排序，识别文本中的数字序列（默认）
 * lexical: 字符编码排序
 * date: 日期排序，强制解析为时间戳比较
 * numeric: 数值排序，强制解析为浮点数比较
 */
export type SortMethod = 'natural' | 'lexical' | 'date' | 'numeric'

/**
 * 排序方向
 * asc: 升序 (1-10, A-Z, 旧-新)
 * desc: 降序 (10-1, Z-A, 新-旧)
 */
export type SortOrder = 'asc' | 'desc'

/**
 * 排序配置
 * 三个参数都是必选项，都有默认值
 */
export interface SortConfig {
  /** 排序类型，默认 'natural' */
  type: SortMethod

  /** 排序方向，默认取决于 type */
  order: SortOrder

  /** 排序字段，默认值由 type 决定 */
  field: string
}

/**
 * SortConfig 各参数默认值
 */
export const SortConfigDefaults: Record<SortMethod, { order: SortOrder; field?: string }> = {
  natural: { order: 'asc', field: 'title' },
  lexical: { order: 'asc', field: 'title' },
  date: { order: 'desc', field: 'date' },
  numeric: { order: 'asc' }, // numeric 必须显式指定 field
}

/**
 * 应用默认值到 SortConfig
 */
export function applySortDefaults(config: Partial<SortConfig>): SortConfig {
  const type = config.type || 'natural'
  const defaults = SortConfigDefaults[type]
  return {
    type,
    order: config.order || defaults.order,
    field: config.field || defaults.field || 'title',
  }
}

// ===== 泛型比较器工厂 =====

/**
 * 创建字符串比较函数
 *
 * @param order     排序方向
 * @param valueFn   从数据项中提取排序值
 * @param natural   是否使用自然排序（数字智能排序）
 */
export function createStringComparator<T>(
  order: SortOrder,
  valueFn: (item: T) => string,
  natural: boolean = true,
): (a: T, b: T) => number {
  const multiplier = order === 'asc' ? 1 : -1

  return (a, b) => {
    const valA = valueFn(a)
    const valB = valueFn(b)
    if (natural) {
      return (
        valA.localeCompare(valB, undefined, {
          numeric: true,
          sensitivity: 'base',
        }) * multiplier
      )
    }
    return valA.localeCompare(valB) * multiplier
  }
}

/**
 * 创建日期比较函数
 *
 * @param order     排序方向
 * @param valueFn   从数据项中提取排序值，返回 Date | null（null 排末尾）
 */
export function createDateComparator<T>(
  order: SortOrder,
  valueFn: (item: T) => Date | null,
): (a: T, b: T) => number {
  const multiplier = order === 'asc' ? 1 : -1

  return (a, b) => {
    const dateA = valueFn(a)
    const dateB = valueFn(b)

    // 无日期的排最后
    if (dateA === null && dateB === null) return 0
    if (dateA === null) return 1
    if (dateB === null) return -1

    return (dateA.getTime() - dateB.getTime()) * multiplier
  }
}

/**
 * 创建数值比较函数
 *
 * @param order     排序方向
 * @param valueFn   从数据项中提取排序值
 */
export function createNumericComparator<T>(
  order: SortOrder,
  valueFn: (item: T) => number,
): (a: T, b: T) => number {
  const multiplier = order === 'asc' ? 1 : -1

  return (a, b) => {
    const numA = valueFn(a)
    const numB = valueFn(b)
    return (numA - numB) * multiplier
  }
}

/**
 * 创建带 tie-breaker 的比较函数
 * 当主比较结果为 0 时，使用 title natural 作为兜底
 *
 * @param config    SortConfig 配置
 * @param primaryValueFn  从数据项中提取主排序字段值
 * @param titleValueFn    从数据项中提取 title 值
 */
export function createComparatorWithTieBreaker<T>(
  config: SortConfig,
  primaryValueFn: (item: T) => number | string | Date | null,
  titleValueFn: (item: T) => string,
): (a: T, b: T) => number {
  let primaryComparator: (a: T, b: T) => number

  switch (config.type) {
    case 'date':
      primaryComparator = createDateComparator(config.order, primaryValueFn as (item: T) => Date | null)
      break
    case 'numeric':
      primaryComparator = createNumericComparator(config.order, primaryValueFn as (item: T) => number)
      break
    case 'natural':
      primaryComparator = createStringComparator(config.order, primaryValueFn as (item: T) => string, true)
      break
    case 'lexical':
      primaryComparator = createStringComparator(config.order, primaryValueFn as (item: T) => string, false)
      break
  }

  const tieBreaker = createStringComparator('asc', titleValueFn, true)

  return (a, b) => {
    const result = primaryComparator(a, b)
    if (result !== 0) return result
    return tieBreaker(a, b)
  }
}
