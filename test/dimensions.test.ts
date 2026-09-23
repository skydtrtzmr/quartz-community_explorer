import { describe, expect, it } from "vitest"
import {
  contextOfFolder,
  entriesInFolder,
  fieldChain,
  parseStoredOrder,
  planFolderDimensions,
  planFolderPartition,
  planNestedPartition,
  resolveDimensionOrder,
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

describe("目录直属子项分区（planFolderPartition）", () => {
  const children = [
    "任务/task-01",
    "任务/task-02",
    "任务/task-03",
    "任务/task-04", // status 缺失 → 未分类
    "任务/task-05", // status 不在清单里 → 未分类
  ]
  const withExtra = [...entries, entry("任务/task-05", { status: "清单外取值" })]

  it("按规则链第一个有取值的字段分区，成员是直属子项", () => {
    const partition = planFolderPartition(withExtra, shared, manifest, "任务", children)!
    expect(partition.field).toBe("status")
    expect(partition.indexSlug).toBe("_dimensions/status/index")
    expect(partition.values.map((v) => [v.value, v.count])).toEqual([
      ["进行中", 2],
      ["已完成", 1],
    ])
    expect(partition.values[0].members).toEqual(["任务/task-01", "任务/task-02"])
    expect(partition.values[0].slug).toBe("_dimensions/status/进行中")
    expect(partition.unassigned).toEqual(["任务/task-04", "任务/task-05"])
    expect(partition.total).toBe(5)
  })

  it("第一个字段在本目录无可用取值时顺延到下一个字段", () => {
    // 项目 的链是 [status, type]：proj-01 有 status → 用 status
    const byStatus = planFolderPartition(withExtra, shared, manifest, "项目", ["项目/proj-01"])!
    expect(byStatus.field).toBe("status")

    // 只挂 proj-02（它没有 status、只有 type）→ status 无取值，顺延到 type
    const byType = planFolderPartition(withExtra, shared, manifest, "项目", ["项目/proj-02"])!
    expect(byType.field).toBe("type")
    expect(byType.values.map((v) => [v.value, v.count])).toEqual([["运营支撑", 1]])
    expect(byType.unassigned).toEqual([])
  })

  it("超出取值上限的成员回落到目录直接子项（不会丢文件）", () => {
    const partition = planFolderPartition(withExtra, shared, manifest, "任务", children, 1)!
    expect(partition.values).toHaveLength(1)
    expect(partition.hiddenValues).toBe(1)
    // 未展示的「已完成」成员必须出现在 unassigned 里
    expect(partition.unassigned).toContain("任务/task-03")
    expect(partition.unassigned).toContain("任务/task-04")
  })

  it("无规则链、无子项、无产物都不分区", () => {
    expect(planFolderPartition(withExtra, shared, manifest, "问答", children)).toBeNull()
    expect(planFolderPartition(withExtra, shared, manifest, "任务", [])).toBeNull()
    expect(planFolderPartition(withExtra, null, manifest, "任务", children)).toBeNull()
  })
})

describe("目录内聚合层级（顺序 / 上限 / 嵌套分区）", () => {
  it("localStorage 顺序解析容错：非法一律当未配置", () => {
    expect(parseStoredOrder(null)).toEqual([])
    expect(parseStoredOrder("not json")).toEqual([])
    expect(parseStoredOrder('{"a":1}')).toEqual([])
    expect(parseStoredOrder('["status", 3, " status ", "type", "type"]')).toEqual(["status", "type"])
  })

  it("未配置 → 用规则链顺序并按上限截断", () => {
    expect(resolveDimensionOrder(["status", "type"], [], 2)).toEqual(["status", "type"])
    expect(resolveDimensionOrder(["status", "type"], [], 1)).toEqual(["status"])
    expect(resolveDimensionOrder(["status", "type"], [], 0)).toEqual(["status"])
  })

  it("已配置 → 以用户顺序为准，链外字段丢弃、未列出视为未启用", () => {
    expect(resolveDimensionOrder(["status", "type"], ["type"], 2)).toEqual(["type"])
    expect(resolveDimensionOrder(["status", "type"], ["链外", "type", "status"], 2)).toEqual(["type", "status"])
    expect(resolveDimensionOrder(["status", "type"], ["type", "status"], 1)).toEqual(["type"])
  })

  it("两层嵌套分区：组内继续分叉，未命中项留在父节点", () => {
    const people: DimensionEntry[] = [
      entry("人员/p1", { type: "工程师", status: "在职" }),
      entry("人员/p2", { type: "工程师", status: "实习" }),
      entry("人员/p3", { type: "工程师" }),
      entry("人员/p4", { type: "架构师", status: "在职" }),
    ]
    const peopleManifest = {
      version: 1,
      fields: [
        { field: "type", fieldSlug: "type", values: [
          { value: "工程师", valueSlug: "工程师" },
          { value: "架构师", valueSlug: "架构师" },
        ] },
        { field: "status", fieldSlug: "status", values: [
          { value: "在职", valueSlug: "在职" },
          { value: "实习", valueSlug: "实习" },
        ] },
      ],
    }
    const sharedPeople = {
      root: { depth: 1 },
      resolved: { 人员: [{ type: "field", field: "type" }, { type: "field", field: "status" }] },
    }
    const children = ["人员/p1", "人员/p2", "人员/p3", "人员/p4"]
    const partition = planNestedPartition(
      people,
      sharedPeople,
      peopleManifest,
      "人员",
      children,
      ["type", "status"],
    )!

    expect(partition.fields).toEqual(["type", "status"])
    expect(partition.leftovers).toEqual([])
    expect(partition.values.map((v) => [v.value, v.count, v.members, v.children.map((c) => c.value)])).toEqual([
      ["工程师", 3, ["人员/p3"], ["在职", "实习"]],
      ["架构师", 1, [], ["在职"]],
    ])
    const engineer = partition.values[0]
    expect(engineer.children[0].slug).toBe("_dimensions/status/在职")
    expect(engineer.children[0].members).toEqual(["人员/p1"])
    expect(engineer.slug).toBe("_dimensions/type/工程师")

    // 只应用一级：成员直接挂在取值节点上
    const single = planNestedPartition(people, sharedPeople, peopleManifest, "人员", children, ["type"])!
    expect(single.values[0].members).toEqual(["人员/p1", "人员/p2", "人员/p3"])
    expect(single.values[0].children).toEqual([])
  })

  it("第一个字段在本目录无取值时顺延到下一个字段", () => {
    const partition = planNestedPartition(
      entries,
      shared,
      manifest,
      "项目",
      ["项目/proj-02"],
      ["status", "type"],
    )!
    expect(partition.fields).toEqual(["type"])
    expect(partition.values.map((v) => v.value)).toEqual(["运营支撑"])
  })

  it("取值上限截断时成员回落（不丢文件）", () => {
    const taskChildren = ["任务/task-01", "任务/task-02", "任务/task-03", "任务/task-04"]
    const partition = planNestedPartition(
      entries,
      shared,
      manifest,
      "任务",
      taskChildren,
      ["status"],
      1,
    )!
    expect(partition.values).toHaveLength(1)
    expect(partition.values[0].value).toBe("进行中")
    // 未展示的「已完成」成员必须回落，不能丢
    expect(partition.leftovers).toContain("任务/task-03")
  })
})
