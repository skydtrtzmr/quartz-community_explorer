/**
 * 左侧目录树的「动态分类子文件夹」：目录 → 维度（字段）→ 取值。
 *
 * 数据来源（两个站点级产物，运行期 fetch，均很小）：
 * - `static/aggregation.json`（aggregation-pro）：`resolved[目录上下文]` = 该目录生效的规则链
 * - `graph/dimensions/index.json`（aggregation-page-pro）：字段/取值的 slug 清单
 *   （取值 slug 会做冲突消解，运行期无法靠 slugify 复现，必须用清单）
 *
 * 语义与文件夹页入口（`AggregationNav`）保持一致：**只统计当前目录子树**、字段顺序沿用规则链顺序、
 * 取值按计数降序；每个取值链到维度值页并带 `?scope=<当前目录>`。
 */
import { slugifyPath } from "@quartz-community/utils/path"

export interface DimensionEntry {
  slug: string
  frontmatter?: Record<string, unknown>
}

export interface DimensionFieldRule {
  type: string
  field?: string
}

export interface SharedAggregationArtifact {
  root?: { depth?: number }
  resolved?: Record<string, DimensionFieldRule[]>
}

export interface DimensionManifest {
  version?: number
  fields?: Array<{ field: string; fieldSlug: string; values?: Array<{ value: string; valueSlug: string }> }>
}

export interface DimensionValueNode {
  value: string
  /** 维度值页 slug：`_dimensions/<fieldSlug>/<valueSlug>` */
  slug: string
  count: number
}

export interface DimensionFieldNode {
  field: string
  fieldSlug: string
  /** 字段索引页 slug：`_dimensions/<fieldSlug>/index` */
  indexSlug: string
  /** 该字段在目录子树内的实体数 */
  count: number
  values: DimensionValueNode[]
  /** 因超出上限而未展示的取值数 */
  hiddenValues: number
}

/** 与 aggregation-page-pro 的 DIMENSIONS_PREFIX 保持一致 */
export const DIMENSIONS_PREFIX = "_dimensions"

/**
 * frontmatter 字段缺值（缺失 / 空串 / 空数组）时的取值名。
 *
 * ⚠️ 跨插件字符串契约：必须与 graph-pro 的 `UNCLASSIFIED_KEY`、aggregation-page-pro 的
 * `UNCLASSIFIED_VALUE` **逐字符一致** —— 目录树里「未分类」节点的可跳转 slug 取自 manifest，
 * 与图谱「未分类」聚合节点指向同一维度值页。插件之间不能共享包，故各自定义并以单测断言字面量。
 */
export const UNCLASSIFIED_VALUE = "未分类"

// ========== 用户配置的「目录内聚合层级」==========
// 约定：候选字段只能是该目录规则链上的字段（维度页是构建期产物）；
// 用户配置 = 字段名数组（优先级从高到低），只有**前 maxLevels 个**真正参与分区。
// 存储（localStorage）与键名由运行期脚本负责，这里只做纯逻辑。

/**
 * 解析 localStorage 里的顺序配置：任何非法输入都当作"未配置"（返回空数组），
 * 并顺手去重、去空、去非字符串。
 */
export function parseStoredOrder(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const order: string[] = []
    for (const item of parsed) {
      if (typeof item !== "string") continue
      const field = item.trim()
      if (field.length === 0 || order.includes(field)) continue
      order.push(field)
    }
    return order
  } catch {
    return []
  }
}

/**
 * 实际参与分区的字段顺序。
 *
 * - **有用户配置**：以用户顺序为准，链外字段直接丢弃；未出现在配置里的链上字段视为"未启用"
 * - **无用户配置**：用 YAML 规则链的顺序（即"默认取链上前 N 项"）
 * - 最后按 `maxLevels` 截断（下限 1）
 */
export function resolveDimensionOrder(
  chain: string[],
  stored: string[],
  maxLevels: number,
): string[] {
  const cap = Math.max(1, Math.floor(maxLevels) || 1)
  const take = (fields: string[]) => fields.filter((field) => chain.includes(field)).slice(0, cap)
  return stored.length === 0 ? take(chain) : take(stored)
}

/** 某个维度值要“收纳”的直属子项（用于把值渲染成含内容的子文件夹） */
export interface DimensionPartitionValue {
  value: string
  /** 维度值页 slug */
  slug: string
  /** 收纳的直属子项数 */
  count: number
  /** 收纳的直属子项 slug（文件） */
  members: string[]
}

/** 目录直属子项按「主维度」的分区结果 */
export interface DimensionPartition {
  field: string
  fieldSlug: string
  indexSlug: string
  /** 按收纳数量降序、同数按值升序 */
  values: DimensionPartitionValue[]
  /** 该字段为空 / 取值不在清单里 / 超出上限 → 保持为目录的直接子项 */
  unassigned: string[]
  /** 参与分区的直属子项（文件）总数 */
  total: number
  /** 因超出上限而未成为子文件夹的取值数 */
  hiddenValues: number
}

/**
 * 把目录的**直属子项**按规则链里第一个「有可用取值」的字段分区。
 *
 * 与 `planFolderDimensions` 的区别（两者用途不同）：
 * - `planFolderDimensions`：**子树**口径的计数，用于「字段/取值 → 页面」的链接节点
 * - 本函数：**直属子项**口径的归属，用于把取值渲染成"装着子文件的子文件夹"
 *
 * 只按第一个有取值的字段分区，是因为一个子项只能待在一个子文件夹里（不能同时归到两个维度）；
 * 其余维度仍以链接节点形式提供入口。属性为空则归入「未分类」取值；取值不在清单/超出上限仍留在目录下。
 */
export function planFolderPartition(
  entries: DimensionEntry[],
  shared: SharedAggregationArtifact | null,
  manifest: DimensionManifest | null,
  folder: string,
  childSlugs: string[],
  maxValues: number = DEFAULT_DIMENSION_MAX_VALUES,
): DimensionPartition | null {
  if (!shared?.resolved || folder === "" || childSlugs.length === 0) return null

  const context = contextOfFolder(folder, shared.root?.depth ?? 1)
  const chain = fieldChain(shared.resolved[context])
  if (chain.length === 0) return null

  const frontmatterBySlug = new Map<string, Record<string, unknown> | undefined>()
  for (const entry of entries) frontmatterBySlug.set(entry.slug, entry.frontmatter)

  const manifestByField = new Map<string, Map<string, string>>()
  const fieldSlugs = new Map<string, string>()
  for (const field of manifest?.fields ?? []) {
    fieldSlugs.set(field.field, field.fieldSlug)
    const values = new Map<string, string>()
    for (const value of field.values ?? []) values.set(value.value, value.valueSlug)
    manifestByField.set(field.field, values)
  }

  for (const field of chain) {
    const valueSlugs = manifestByField.get(field)
    if (!valueSlugs) continue

    const buckets = new Map<string, string[]>()
    let assigned = 0
    for (const slug of childSlugs) {
      // 缺值归入「未分类」取值（清单里没有该取值时下面的检查兜回落 unassigned）
      const value = firstValue(frontmatterBySlug.get(slug)?.[field]) ?? UNCLASSIFIED_VALUE
      const valueSlug = valueSlugs.get(value)
      if (valueSlug === undefined) continue
      const bucket = buckets.get(value) ?? []
      bucket.push(slug)
      buckets.set(value, bucket)
      assigned++
    }
    if (assigned === 0) continue

    const fieldSlug = fieldSlugs.get(field) ?? slugifyPath(field)
    const all = [...buckets.entries()]
      .map(([value, members]) => ({
        value,
        members,
        count: members.length,
        slug: `${DIMENSIONS_PREFIX}/${fieldSlug}/${valueSlugs.get(value)!}`,
      }))
      .sort((a, b) => b.count - a.count || compareStrings(a.value, b.value))

    const shown = all.slice(0, maxValues)
    const shownSlugs = new Set(shown.flatMap((entry) => entry.members))
    // 超出上限的取值：其成员收回目录直接子项，避免"文件消失"
    const unassigned = childSlugs.filter((slug) => !shownSlugs.has(slug))
    return {
      field,
      fieldSlug,
      indexSlug: `${DIMENSIONS_PREFIX}/${fieldSlug}/index`,
      values: shown,
      unassigned,
      total: childSlugs.length,
      hiddenValues: Math.max(0, all.length - shown.length),
    }
  }
  return null
}

/** 单字段最多展示的取值数（默认 20），避免高基数字段把树撑爆 */
export const DEFAULT_DIMENSION_MAX_VALUES = 20

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 把 `[[target]]` / `[[target|display]]` 剥离为纯文本（display 优先，否则 target） */
function stripWikilink(value: string): string {
  const match = value.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/)
  if (!match) return value
  const target = match[1] ?? ""
  const display = match[2] ?? ""
  return display.trim() || target.trim()
}

/** 与 aggregation-page-pro 的 firstValue 同款：数组取第一个「有值」的元素；wikilink 值剥离为纯文本 */
function firstValue(raw: unknown): string | null {
  const present = (v: unknown) => v !== undefined && v !== null && v !== ""
  const value = Array.isArray(raw) ? raw.find(present) : present(raw) ? raw : undefined
  return value === undefined ? null : stripWikilink(String(value))
}

/** 目录 → 聚合上下文：按 root.depth 截断（根目录为 "/"） */
export function contextOfFolder(folder: string, depth: number): string {
  const parts = folder.split("/").filter((part) => part.length > 0).slice(0, Math.max(1, depth))
  return parts.join("/") || "/"
}

/** 规则链上的字段名（按顺序去重） */
export function fieldChain(chain: DimensionFieldRule[] | undefined): string[] {
  const fields: string[] = []
  for (const rule of chain ?? []) {
    if (rule?.type === "field" && typeof rule.field === "string" && rule.field.length > 0) {
      if (!fields.includes(rule.field)) fields.push(rule.field)
    }
  }
  return fields
}

/** 取目录子树内的实体（按目录段前缀匹配，避免 `示例` 命中 `示例集`） */
export function entriesInFolder(entries: DimensionEntry[], folder: string): DimensionEntry[] {
  if (folder === "") return entries
  const prefix = `${folder}/`
  return entries.filter((entry) => entry.slug.startsWith(prefix))
}

/**
 * 计算某个目录要挂到树上的维度节点（无可用维度时返回空数组）。
 *
 * @param entries contentIndex 的条目（含 frontmatter）
 * @param shared  aggregation.json 内容
 * @param manifest graph/dimensions/index.json 内容
 * @param folder 目录路径（不含首尾斜杠；根目录传 ""）
 */
export function planFolderDimensions(
  entries: DimensionEntry[],
  shared: SharedAggregationArtifact | null,
  manifest: DimensionManifest | null,
  folder: string,
  maxValues: number = DEFAULT_DIMENSION_MAX_VALUES,
): DimensionFieldNode[] {
  if (!shared?.resolved || folder === "") return []

  const context = contextOfFolder(folder, shared.root?.depth ?? 1)
  const chain = fieldChain(shared.resolved[context])
  if (chain.length === 0) return []

  const scoped = entriesInFolder(entries, folder)
  if (scoped.length === 0) return []

  // 取值 slug 必须来自清单（冲突消解后的权威结果）
  const manifestByField = new Map<string, Map<string, string>>()
  for (const field of manifest?.fields ?? []) {
    const values = new Map<string, string>()
    for (const value of field.values ?? []) values.set(value.value, value.valueSlug)
    manifestByField.set(field.field, values)
  }

  const counts = new Map<string, Map<string, number>>()
  for (const entry of scoped) {
    for (const field of chain) {
      const value = firstValue(entry.frontmatter?.[field]) ?? UNCLASSIFIED_VALUE
      const slug = manifestByField.get(field)?.get(value)
      if (slug === undefined) continue // 清单里没有（字段被 maxValuesPerField 跳过等）→ 不挂节点
      const byValue = counts.get(field) ?? new Map<string, number>()
      byValue.set(value, (byValue.get(value) ?? 0) + 1)
      counts.set(field, byValue)
    }
  }

  const fieldSlugs = new Map<string, string>()
  for (const field of manifest?.fields ?? []) fieldSlugs.set(field.field, field.fieldSlug)

  const nodes: DimensionFieldNode[] = []
  for (const field of chain) {
    const byValue = counts.get(field)
    if (!byValue || byValue.size === 0) continue
    const fieldSlug = fieldSlugs.get(field) ?? slugifyPath(field)
    const all = [...byValue.entries()]
      .map(([value, count]) => ({
        value,
        count,
        slug: `${DIMENSIONS_PREFIX}/${fieldSlug}/${manifestByField.get(field)!.get(value)!}`,
      }))
      .sort((a, b) => b.count - a.count || compareStrings(a.value, b.value))
    nodes.push({
      field,
      fieldSlug,
      indexSlug: `${DIMENSIONS_PREFIX}/${fieldSlug}/index`,
      count: [...byValue.values()].reduce((sum, n) => sum + n, 0),
      values: all.slice(0, maxValues),
      hiddenValues: Math.max(0, all.length - maxValues),
    })
  }
  return nodes
}

// ========== 多层嵌套分区（用户配置的层级顺序）==========

/** 一个取值节点：本层的一个取值，可继续往下按下一个字段分区 */
export interface PartitionValueNode {
  /** 本节点使用的字段（用于展开键、链接） */
  field: string
  fieldSlug: string
  value: string
  /** 维度值页 slug（`_dimensions/<fieldSlug>/<valueSlug>`） */
  slug: string
  /** 本节点（含更深层级）收纳的直属子项数 */
  count: number
  /** 直接放在本节点下的子项（更深层级未命中的 + 最深层级的全部） */
  members: string[]
  /** 更深层级（按 `fields[k+1]`）；空数组表示到底了 */
  children: PartitionValueNode[]
  /** 更深层级里因取值上限被截断的取值数 */
  hiddenValues: number
}

export interface FolderPartition {
  /** 实际应用的字段顺序（已过滤链外字段、已按上限截断） */
  fields: string[]
  values: PartitionValueNode[]
  /** 目录下保留（未参与分区）的直属子项 */
  leftovers: string[]
  /** 参与分区的直属子项总数 */
  total: number
}

interface LevelResult {
  values: PartitionValueNode[]
  leftovers: string[]
  hiddenValues: number
}

/** 递归分区的一层：把 items 按 fields[0] 分组，组内再按后续字段继续分 */
function partitionLevel(
  items: string[],
  frontmatter: Map<string, Record<string, unknown> | undefined>,
  fields: string[],
  manifestByField: Map<string, Map<string, string>>,
  fieldSlugs: Map<string, string>,
  maxValues: number,
): LevelResult {
  const field = fields[0]
  const valueSlugs = field === undefined ? undefined : manifestByField.get(field)
  if (field === undefined || valueSlugs === undefined) {
    return { values: [], leftovers: items, hiddenValues: 0 }
  }

  const buckets = new Map<string, string[]>()
  const leftovers: string[] = []
  for (const slug of items) {
    // 缺值不是「留在本层」，而是归入「未分类」取值（清单里没有该取值时下面的检查兜回落 leftover）
    const value = firstValue(frontmatter.get(slug)?.[field]) ?? UNCLASSIFIED_VALUE
    const valueSlug = valueSlugs.get(value)
    if (valueSlug === undefined) {
      leftovers.push(slug) // 取值不在清单里（字段被上限跳过等）→ 留在本层父节点
      continue
    }
    const bucket = buckets.get(value) ?? []
    bucket.push(slug)
    buckets.set(value, bucket)
  }
  if (buckets.size === 0) return { values: [], leftovers: items, hiddenValues: 0 }

  const fieldSlug = fieldSlugs.get(field) ?? slugifyPath(field)
  const sorted = [...buckets.entries()].sort(
    (a, b) => b[1].length - a[1].length || compareStrings(a[0], b[0]),
  )
  const shown = sorted.slice(0, maxValues)
  const hidden = sorted.slice(maxValues)
  // 被上限截断的取值：其成员回落到本层父节点（不丢文件）
  for (const [, members] of hidden) leftovers.push(...members)

  const values: PartitionValueNode[] = shown.map(([value, members]) => {
    const deeper: LevelResult =
      fields.length > 1
        ? partitionLevel(members, frontmatter, fields.slice(1), manifestByField, fieldSlugs, maxValues)
        : { values: [], leftovers: members, hiddenValues: 0 }
    return {
      field,
      fieldSlug,
      value,
      slug: `${DIMENSIONS_PREFIX}/${fieldSlug}/${valueSlugs.get(value)!}`,
      count: members.length,
      members: deeper.leftovers,
      children: deeper.values,
      hiddenValues: deeper.hiddenValues,
    }
  })

  return { values, leftovers, hiddenValues: hidden.length }
}

/**
 * 目录直属子项的多层嵌套分区。
 *
 * - `order` 由调用方给出（`resolveDimensionOrder(链, 用户配置, 上限)`），本函数不再做截断
 * - 每一层都遵循"文件不丢"：属性为空 → 归入「未分类」取值；取值不在清单/超上限 → 留在该层父节点
 * - 最深层级的取值节点用 `members` 收纳剩余成员；中间层级用 `children` 继续分叉
 */
export function planNestedPartition(
  entries: DimensionEntry[],
  shared: SharedAggregationArtifact | null,
  manifest: DimensionManifest | null,
  folder: string,
  childSlugs: string[],
  order: string[],
  maxValues: number = DEFAULT_DIMENSION_MAX_VALUES,
): FolderPartition | null {
  if (!shared?.resolved || folder === "" || childSlugs.length === 0 || order.length === 0) {
    return null
  }

  const frontmatter = new Map<string, Record<string, unknown> | undefined>()
  for (const entry of entries) frontmatter.set(entry.slug, entry.frontmatter)

  const manifestByField = new Map<string, Map<string, string>>()
  const fieldSlugs = new Map<string, string>()
  for (const field of manifest?.fields ?? []) {
    fieldSlugs.set(field.field, field.fieldSlug)
    const values = new Map<string, string>()
    for (const value of field.values ?? []) values.set(value.value, value.valueSlug)
    manifestByField.set(field.field, values)
  }

  // 逐层挑"确实有可用取值"的字段：本级无任何命中就顺延到下一个（例如某目录顺序里第一个字段全为空）
  let fields = order
  let chosen: LevelResult | null = null
  for (let i = 0; i < order.length; i++) {
    const candidate = partitionLevel(childSlugs, frontmatter, order.slice(i), manifestByField, fieldSlugs, maxValues)
    if (candidate.values.length > 0) {
      fields = order.slice(i)
      chosen = candidate
      break
    }
  }
  if (!chosen) return null

  return {
    fields,
    values: chosen.values,
    leftovers: chosen.leftovers,
    total: childSlugs.length,
  }
}
