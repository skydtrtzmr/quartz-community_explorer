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

/** 单字段最多展示的取值数（默认 20），避免高基数字段把树撑爆 */
export const DEFAULT_DIMENSION_MAX_VALUES = 20

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 与 aggregation-page-pro 的 firstValue 同款：数组取第一个「有值」的元素 */
function firstValue(raw: unknown): string | null {
  const present = (v: unknown) => v !== undefined && v !== null && v !== ""
  const value = Array.isArray(raw) ? raw.find(present) : present(raw) ? raw : undefined
  return value === undefined ? null : String(value)
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
      const value = firstValue(entry.frontmatter?.[field])
      if (value === null) continue
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
