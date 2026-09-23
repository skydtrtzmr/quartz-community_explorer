import { describe, expect, it } from "vitest"
import {
  contextOfFolder,
  entriesInFolder,
  fieldChain,
  planFolderDimensions,
  type DimensionEntry,
} from "../src/util/dimensions"

const shared = {
  root: { depth: 1 },
  resolved: {
    任务: [{ type: "field", field: "status" }],
    项目: [
      { type: "field", field: "status" },
      { type: "field", field: "type" },
    ],
    问答: [],
  },
}

const manifest = {
  version: 1,
  fields: [
    {
      field: "status",
      fieldSlug: "status",
      values: [
        { value: "进行中", valueSlug: "进行中" },
        { value: "已完成", valueSlug: "已完成" },
        { value: "未知取值", valueSlug: "unknown" },
      ],
    },
    {
      field: "type",
      fieldSlug: "type",
      values: [
        { value: "产品研发", valueSlug: "产品研发" },
        { value: "运营支撑", valueSlug: "运营支撑" },
      ],
    },
  ],
}

const entry = (slug: string, frontmatter: Record<string, unknown> = {}): DimensionEntry => ({
  slug,
  frontmatter,
})

const entries: DimensionEntry[] = [
  entry("任务/task-01", { status: "进行中" }),
  entry("任务/task-02", { status: "进行中" }),
  entry("任务/task-03", { status: "已完成" }),
  entry("任务/年度/task-04", { status: "进行中" }),
  entry("项目/proj-01", { status: "进行中", type: "产品研发" }),
  entry("项目/proj-02", { type: "运营支撑" }),
  entry("问答/qa-01", { status: "进行中" }),
  entry("示例集/x", { status: "进行中" }),
]

describe("目录树动态分类（planFolderDimensions）", () => {
  it("上下文按 root.depth 截断", () => {
    expect(contextOfFolder("任务/年度", 1)).toBe("任务")
    expect(contextOfFolder("任务/年度", 2)).toBe("任务/年度")
    expect(contextOfFolder("", 1)).toBe("/")
  })

  it("子树前缀按目录段匹配，不误伤同前缀目录", () => {
    expect(entriesInFolder(entries, "示例").length).toBe(0)
    expect(entriesInFolder(entries, "任务").length).toBe(4)
  })

  it("规则链只取 field 规则并按顺序去重", () => {
    expect(fieldChain([{ type: "folder" }, { type: "field", field: "b" }, { type: "field", field: "b" }])).toEqual([
      "b",
    ])
  })

  it("目录 → 维度 → 取值：计数为子树口径、按计数降序、带可跳转 slug", () => {
    const nodes = planFolderDimensions(entries, shared, manifest, "任务")
    expect(nodes).toHaveLength(1)
    const [status] = nodes
    expect(status.field).toBe("status")
    expect(status.indexSlug).toBe("_dimensions/status/index")
    expect(status.count).toBe(4)
    expect(status.values).toEqual([
      { value: "进行中", count: 3, slug: "_dimensions/status/进行中" },
      { value: "已完成", count: 1, slug: "_dimensions/status/已完成" },
    ])
  })

  it("嵌套目录继承顶级目录的规则链", () => {
    const nodes = planFolderDimensions(entries, shared, manifest, "任务/年度")
    expect(nodes).toHaveLength(1)
    expect(nodes[0].values).toEqual([
      { value: "进行中", count: 1, slug: "_dimensions/status/进行中" },
    ])
  })

  it("多个字段按规则链顺序输出，缺失字段不计入", () => {
    const nodes = planFolderDimensions(entries, shared, manifest, "项目")
    expect(nodes.map((node) => node.field)).toEqual(["status", "type"])
    expect(nodes[0].count).toBe(1) // 只有 proj-01 有 status
    expect(nodes[1].count).toBe(2)
  })

  it("显式空链、根目录、清单缺失取值都不挂节点", () => {
    expect(planFolderDimensions(entries, shared, manifest, "问答")).toEqual([])
    expect(planFolderDimensions(entries, shared, manifest, "")).toEqual([])
    const withoutManifestValue = planFolderDimensions(
      [entry("任务/a", { status: "清单里没有的值" })],
      shared,
      manifest,
      "任务",
    )
    expect(withoutManifestValue).toEqual([])
  })

  it("超过上限时给出 hiddenValues", () => {
    const nodes = planFolderDimensions(entries, shared, manifest, "任务", 1)
    expect(nodes[0].values).toHaveLength(1)
    expect(nodes[0].hiddenValues).toBe(1)
  })

  it("没有 aggregation 产物时整体不挂", () => {
    expect(planFolderDimensions(entries, null, manifest, "任务")).toEqual([])
    expect(planFolderDimensions(entries, { root: { depth: 1 } }, manifest, "任务")).toEqual([])
  })
})
