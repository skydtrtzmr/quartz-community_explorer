import { FileTrieNode, type ContentIndexEntry } from "../../util/fileTrie"
import {
  contextOfFolder,
  fieldChain,
  parseStoredOrder,
  planFolderDimensions,
  planNestedPartition,
  resolveDimensionOrder,
  type DimensionEntry,
  type DimensionManifest,
  type PartitionValueNode,
  type SharedAggregationArtifact,
} from "../../util/dimensions"
import type { FullSlug } from "@quartz-community/types"

// TODO
// - [ ] 添加对 stickyHeaders 选项的支持
// - [ ] 添加对定位按钮功能的支持

// stickyHeaders需要做到；
// - [ ]  吸顶效果：滚动时父级文件夹标题吸附在顶部
// - [ ]  当文件夹项出现在stickyheader时，隐藏对应的普通文件夹项

// 定位需要做到：
// - [ ]  自动展开目标文件所在路径的所有父级文件夹
// - [ ]  滚动定位至目标文件节点（即使其当前未渲染）
// - [ ]  若目标文件不在当前虚拟渲染窗口内，主动触发增量重渲染以确保其可见

// 现存缺陷：
// 首次加载页面后，若再次刷新， [setupExplorer3] 异步完成的耗时会变长，
// 且此时必须等待 [setupExplorer3] 异步完成再操作，否则可能导致再也没法正常渲染目录。

type MaybeHTMLElement = HTMLElement | undefined

interface ParsedOptions {
  folderClickBehavior: "collapse" | "link"
  folderDefaultState: "collapsed" | "open"
  useSavedState: boolean
  virtualScrollWindowSize: number
  hideFiles: boolean // 隐藏末级文件：只显示文件夹
  dimensionFolders: boolean // 目录下是否挂「维度 → 取值」动态分类节点
  dimensionMaxValues: number // 单字段最多展示的取值数
  dimensionMaxLevels: number // 最多应用几级维度（用户拖动的顺序只取前 N 项）
  sortFn: (a: FileTrieNode, b: FileTrieNode) => number
  filterFn: (node: FileTrieNode) => boolean
  mapFn: (node: FileTrieNode) => void
  order: "sort" | "filter" | "map"[]
}

// ========== 步骤 1：扁平化数据层 ==========
// 扁平化节点：树形结构转换为扁平列表后的节点
interface FlatNode {
  node: FileTrieNode // 原始树节点引用
  level: number // 层级深度（0 = 根级）
  parentPath: string // 父级路径
  index: number // 在扁平数组中的索引
}

let globalOpts: ParsedOptions | null = null
let currentActiveSlug: FullSlug | null = null // 当前活跃文件
let isNavigating: boolean = false // 导航锁定标志，防止滚动事件干扰定位

// ========== 扁平化虚拟滚动状态（步骤 1） ==========
let flatNodes: FlatNode[] = [] // 扁平化后的所有节点
let expandedFolders: Set<string> = new Set() // 展开的文件夹 slug 集合
let flatRenderStart: number = 0 // 当前渲染起始索引（步骤 4 使用）
let flatRenderEnd: number = 0 // 当前渲染结束索引（步骤 4 使用）

// 全局引用（用于 refreshFlatExplorer）
let currentTrie: FileTrieNode | null = null // 当前文件树
let currentExplorerUl: Element | null = null // 当前 Explorer UL 元素
let basePath: string = "" // 从 data-basepath 获取的子路径（如 "xm"）

// 生成带 basePath 的链接
function getHref(slug: string): string {
  return basePath ? `/${basePath}/${slug}` : `/${slug}`
}

// 维度节点链接：额外带 `?scope=<目录>`（与文件夹页入口、维度值页的裁剪口径一致）
function getDimensionHref(slug: string, query: string): string {
  return getHref(slug) + query
}

// ========== 动态分类（目录 → 维度 → 取值）==========
// 数据来自两个站点级产物：static/aggregation.json（规则链）与 graph/dimensions/index.json（slug 清单）。
// 站点没配 aggregation 时 aggregation.json 404 → 整体跳过（不报错、不挂任何节点）。
interface DimensionSources {
  shared: SharedAggregationArtifact | null
  manifest: DimensionManifest | null
}

let dimensionSourcesPromise: Promise<DimensionSources | null> | null = null

function staticUrl(relative: string): string {
  return basePath ? `/${basePath}/${relative}` : `/${relative}`
}

function loadDimensionSources(): Promise<DimensionSources | null> {
  if (!dimensionSourcesPromise) {
    dimensionSourcesPromise = (async () => {
      try {
        const sharedResponse = await fetch(staticUrl("static/aggregation.json"))
        if (!sharedResponse.ok) return null
        const shared = (await sharedResponse.json()) as SharedAggregationArtifact
        let manifest: DimensionManifest | null = null
        try {
          const manifestResponse = await fetch(staticUrl("graph/dimensions/index.json"))
          if (manifestResponse.ok) manifest = (await manifestResponse.json()) as DimensionManifest
        } catch {
          // 清单缺失：没有 slug 映射 → planFolderDimensions 自然挂不出节点
        }
        return { shared, manifest }
      } catch (error) {
        console.warn("[explorer3] 维度分类产物加载失败", error)
        return null
      }
    })()
  }
  return dimensionSourcesPromise
}

// ===== 「目录内聚合层级」配置（跨插件契约：aggregation-page-pro 的面板写、本脚本读）=====
/** localStorage 键前缀：`quartz:dimensionOrder:<basePath>:<目录>`（值 = 字段名数组） */
const DIMENSION_ORDER_PREFIX = "quartz:dimensionOrder:"
/** 面板改配置后派发的事件（本脚本监听并重建目录树） */
const DIMENSION_ORDER_EVENT = "aggregation-order-changed"

function dimensionOrderKey(folder: string): string {
  return `${DIMENSION_ORDER_PREFIX}${basePath}:${folder}`
}

/** 读取用户配置的顺序（容错：任何异常都当未配置） */
function readDimensionOrder(folder: string): string[] {
  try {
    return parseStoredOrder(localStorage.getItem(dimensionOrderKey(folder)))
  } catch {
    return []
  }
}

/** 注入前的原始子节点快照：配置变更时用它还原，避免"还原靠重建整棵树" */
const originalChildren = new Map<string, FileTrieNode[]>()

/** 最近一次注入用的源内容（配置变更重排时复用，避免重新拉取/解析 contentIndex） */
let currentDimensionEntries: DimensionEntry[] = []

/** 收集一次分区里所有被收纳的子项（含更深层级） */
function collectAssigned(values: PartitionValueNode[]): Set<string> {
  const assigned = new Set<string>()
  const walk = (nodes: PartitionValueNode[]) => {
    for (const node of nodes) {
      for (const member of node.members) assigned.add(member)
      walk(node.children)
    }
  }
  walk(values)
  return assigned
}

/**
 * 把（可能嵌套的）取值节点转成树节点：
 * - `hideFiles: false`（默认）：取值 = 可展开的子文件夹，里面是命中该取值的直属文件；
 *   若配置了二级字段，则先放二级取值子文件夹，再放本层未命中二级的文件
 * - `hideFiles: true`（只显示目录）：渲染成叶子，点击进维度值页
 *
 * 展开键用「目录 + 字段层级链」组成，避免不同层级/不同目录互相联动。
 */
function partitionValueToTrie(
  node: PartitionValueNode,
  folder: string,
  hideFiles: boolean,
  childBySlug: Map<string, FileTrieNode>,
  parentKey: string,
): FileTrieNode {
  const key = `${parentKey}/${node.fieldSlug}=${node.value}`
  const childValueNodes = node.children.map((child) =>
    partitionValueToTrie(child, folder, hideFiles, childBySlug, key),
  )
  const memberNodes = hideFiles
    ? []
    : node.members
        .map((slug) => childBySlug.get(slug))
        .filter((child): child is FileTrieNode => child !== undefined)
  const trie = {
    isFolder: !hideFiles || childValueNodes.length > 0,
    slug: node.slug,
    expandKey: `dimval:${folder}:${key}`,
    displayName: `${node.value} (${node.count})`,
    dimensionQuery: `?scope=${encodeURIComponent(folder)}`,
    children: [...childValueNodes, ...memberNodes],
  }
  return trie as unknown as FileTrieNode
}

/**
 * 在每个目录下按**主维度**分区：把该目录的直属文件收进「维度值子文件夹」，其余文件留在目录下。
 *
 * 为什么只按一个维度：一个文件只能待在一个子文件夹里（不能同时归到两个维度）。
 * 其余维度仍可从文件夹页的「本目录维度」入口进入（将来由「目录内聚合配置」让用户选择用哪个维度）。
 * 注意：先递归原 children、再重建，避免把注入的节点当成真实目录继续处理。
 */
async function injectDimensionNodes(
  trie: FileTrieNode,
  entries: DimensionEntry[],
  opts: ParsedOptions,
): Promise<number> {
  const sources = await loadDimensionSources()
  const shared = sources?.shared ?? null
  const manifest = sources?.manifest ?? null
  const resolved = shared?.resolved ?? null
  if (!resolved) {
    console.log("[explorer3] 动态分类：未找到 static/aggregation.json，跳过")
    return 0
  }
  const contextDepth = shared?.root?.depth ?? 1

  currentDimensionEntries = entries
  let injected = 0
  const walk = (node: FileTrieNode) => {
    const children = [...node.children]
    for (const child of children) walk(child)

    if (!node.isFolder) return
    const folder = node.slug.replace(/\/index$/, "")
    if (folder === "") return

    // 原始子节点快照（第一次注入时记下）：配置变更时直接还原，无需重建整棵树
    if (!originalChildren.has(node.slug)) originalChildren.set(node.slug, node.children)

    const subFolders = node.children.filter((child) => child.isFolder)
    const files = node.children.filter((child) => !child.isFolder)

    // 本目录实际应用的字段顺序 = 用户配置（若有）→ 否则规则链，再按站点上限截断
    const context = contextOfFolder(folder, contextDepth)
    const chain = fieldChain(resolved[context])
    const order = resolveDimensionOrder(chain, readDimensionOrder(folder), opts.dimensionMaxLevels)
    if (order.length === 0) return

    // 只显示目录（hideFiles）：文件已被过滤出树，按**子树**计数给出取值叶子（点击进维度值页）
    if (opts.hideFiles) {
      const plans = planFolderDimensions(entries, shared, manifest, folder, opts.dimensionMaxValues)
      const primary = plans.find((plan) => plan.field === order[0]) ?? plans[0]
      if (!primary) return
      const leafNodes = primary.values.map((value) =>
        partitionValueToTrie(
          {
            field: primary.field,
            fieldSlug: primary.fieldSlug,
            value: value.value,
            slug: value.slug,
            count: value.count,
            members: [],
            children: [],
            hiddenValues: 0,
          },
          folder,
          true,
          new Map(),
          "",
        ),
      )
      node.children = [...subFolders, ...leafNodes]
      injected += leafNodes.length
      return
    }

    if (files.length === 0) return

    const childBySlug = new Map(files.map((child) => [child.slug, child]))
    const partition = planNestedPartition(
      entries,
      shared,
      manifest,
      folder,
      files.map((child) => child.slug),
      order,
      opts.dimensionMaxValues,
    )
    if (!partition) return

    const valueNodes = partition.values.map((value) =>
      partitionValueToTrie(value, folder, false, childBySlug, ""),
    )
    const movedSlugs = collectAssigned(partition.values)
    const remainingFiles = files.filter((child) => !movedSlugs.has(child.slug))

    // 顺序：真实子文件夹 → 维度值子文件夹 → 未参与分区的文件
    node.children = [...subFolders, ...valueNodes, ...remainingFiles]
    injected += valueNodes.length
  }
  walk(trie)
  if (injected === 0) console.log("[explorer3] 动态分类：没有目录命中规则链")
  return injected
}

/**
 * 配置变更后重排目录树：先还原各目录的原始子节点，再按新配置重新注入，最后重绘。
 * 不重新 fetch 产物、不重建整棵树（产物与内容索引都有缓存）。
 */
async function regroupDimensionNodes(opts: ParsedOptions): Promise<void> {
  if (!currentTrie || currentDimensionEntries.length === 0) return
  for (const [slug, children] of originalChildren) {
    const node = currentTrie.findNode(slug.split("/"))
    if (node) node.children = children
  }
  // 丢掉旧的展开键（字段/层级可能已经变了）
  expandedFolders = new Set([...expandedFolders].filter((key) => !key.startsWith("dimval:")))
  await injectDimensionNodes(currentTrie, currentDimensionEntries, opts)
  refreshFlatExplorer()
}

// 构建时间元数据：等价于 v4 页面注入的 fetchMetadata 全局——请求只发一次并在页面加载时预热，
// 后续每次导航复用同一个已 resolve 的 promise，避免"等网络往返 → 侧栏空白 → 再渲染"造成的闪烁。
let serverBuildTimePromise: Promise<string> | null = null
let serverBuildTimeUrl = ""

function getServerBuildTime(): Promise<string> {
  const metaUrl = basePath ? `/${basePath}/static/metadata.json` : "/static/metadata.json"
  if (!serverBuildTimePromise || serverBuildTimeUrl !== metaUrl) {
    serverBuildTimeUrl = metaUrl
    serverBuildTimePromise = fetch(metaUrl, { cache: "no-cache" })
      .then((res) => (res.ok ? res.json() : null))
      .then((metadata: { lastBuildTime?: unknown } | null) => {
        if (metadata?.lastBuildTime !== undefined && metadata?.lastBuildTime !== null) {
          return String(metadata.lastBuildTime)
        }
        return "unknown"
      })
      .catch(() => "unknown")
  }
  return serverBuildTimePromise
}

/**
 * 切换整个 Explorer 面板的展开/折叠状态
 * 主要用于移动端的菜单切换
 * @this HTMLElement - 触发点击的按钮元素
 */
function toggleExplorer(this: HTMLElement) {
  const nearestExplorer = this.closest(".explorer3") as HTMLElement
  if (!nearestExplorer) return
  const explorerCollapsed = nearestExplorer.classList.toggle("collapsed")
  nearestExplorer.setAttribute(
    "aria-expanded",
    nearestExplorer.getAttribute("aria-expanded") === "true" ? "false" : "true",
  )

  if (!explorerCollapsed) {
    document.documentElement.classList.add("mobile-no-scroll")
  } else {
    document.documentElement.classList.remove("mobile-no-scroll")
  }
}

/**
 * 切换单个文件夹的展开/折叠状态
 * 处理用户点击文件夹箭头或按钮时的交互
 * 包含懒加载触发和状态持久化逻辑
 * @param evt - 鼠标点击事件
 */
function toggleFolder(evt: MouseEvent) {
  evt.stopPropagation()
  const target = evt.target as MaybeHTMLElement
  if (!target) return

  const isSvg = target.nodeName === "svg"

  let folderContainer: MaybeHTMLElement
  if (isSvg) {
    folderContainer = target.parentElement as MaybeHTMLElement
  } else {
    folderContainer = target.closest(".folder3-container") as MaybeHTMLElement
  }

  if (!folderContainer) return

  const folderPath = folderContainer.dataset.folderpath as string
  const wasExpanded = expandedFolders.has(folderPath)

  if (wasExpanded) {
    expandedFolders.delete(folderPath)
  } else {
    expandedFolders.add(folderPath)
  }
  saveExpandedState()

  console.log(
    `%c[toggleFolder] ${folderPath} -> ${wasExpanded ? "折叠" : "展开"}, expandedFolders: ${expandedFolders.size}`,
    "color: #ff8800; font-weight: bold",
  )

  // 重新生成扁平化数据并渲染
  refreshFlatExplorer()
}

/**
 * 创建单个文件节点的 DOM 元素
 * 使用模板克隆方式创建，设置链接和活跃状态
 * @param currentSlug - 当前页面的 slug
 * @param node - 文件节点数据（包含 slug 和 displayName）
 * @param level - 层级深度（用于扁平化结构的缩进），默认值 0（兼容旧调用）
 * @returns 创建的 li 元素
 */
function createFileNode(
  currentSlug: FullSlug,
  node: { slug: FullSlug; displayName: string; dimensionQuery?: string },
  level: number = 0,
): HTMLLIElement {
  const template = document.getElementById("template-file3") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const a = li.querySelector("a") as HTMLAnchorElement
  // 使用 basePath 生成链接（支持子路径部署）；维度取值节点额外带 ?scope=<目录>
  a.href = node.dimensionQuery
    ? getDimensionHref(node.slug, node.dimensionQuery)
    : getHref(node.slug)
  a.dataset.for = node.slug
  a.textContent = node.displayName
  if (node.dimensionQuery) li.classList.add("dimension-value-node")

  if (currentSlug === node.slug) {
    a.classList.add("active")
    li.dataset.isActive = "true"
  }

  // 步骤 3：扁平化结构动态缩进
  if (level > 0) {
    const indentPx = level * 20 // 每层 20px
    a.style.paddingLeft = `${indentPx + 12}px` // 12px 基础边距
  }

  return li
}

/**
 * 创建简化版文件夹节点（扁平化结构专用）
 * 不包含嵌套的 ul.content，只有文件夹本身的展示
 * @param node - 文件夹节点数据
 * @param level - 层级深度
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 * @returns 创建的 li 元素
 */
function createSimpleFolderNode(
  node: FileTrieNode,
  level: number,
  currentSlug: FullSlug,
  opts: ParsedOptions,
): HTMLLIElement {
  const template = document.getElementById("template-folder3") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const folderContainer = li.querySelector(".folder3-container") as HTMLElement
  const titleContainer = folderContainer.querySelector("div") as HTMLElement
  const folderOuter = li.querySelector(".folder3-outer") as HTMLElement

  // 设置文件夹路径（展开状态按 expandKey 记忆：维度字段节点用它区分「同字段挂在不同目录」）
  const dimensionQuery = (node as unknown as { dimensionQuery?: string }).dimensionQuery
  const expandKey = (node as unknown as { expandKey?: string }).expandKey ?? node.slug
  const folderPath = node.slug
  folderContainer.dataset.folderpath = expandKey
  if (dimensionQuery) li.classList.add("dimension-value-folder")

  // 设置缩进
  const indentPx = level * 20
  folderContainer.style.paddingLeft = `${indentPx + 12}px`

  // 设置文件夹标题
  if (opts.folderClickBehavior === "link") {
    const button = titleContainer.querySelector(".folder3-button") as HTMLElement
    const a = document.createElement("a")
    // 使用 basePath 生成链接（支持子路径部署）；维度字段节点额外带 ?scope=<目录>
    a.href = dimensionQuery
      ? getDimensionHref(folderPath, dimensionQuery)
      : getHref(folderPath)
    a.dataset.for = folderPath
    a.textContent = node.displayName

    if (currentSlug === folderPath) {
      a.classList.add("active")
    }

    button.replaceWith(a)
  } else {
    const wrapper = titleContainer.querySelector(".folder3-content-wrapper") as HTMLElement
    const span = wrapper.querySelector(".folder3-title") as HTMLElement
    span.textContent = node.displayName

    if (currentSlug === folderPath) {
      wrapper.classList.add("active")
    }
  }

  // 设置展开状态（根据 expandedFolders；维度字段节点按 expandKey）
  const isExpanded = expandedFolders.has(expandKey)
  if (isExpanded) {
    folderOuter.classList.add("open")
  } else {
    folderOuter.classList.remove("open")
  }

  // 移除 ul.content（扁平化结构不需要嵌套）
  const ul = folderOuter.querySelector("ul")
  if (ul) {
    ul.remove()
  }

  // 绑定点击事件到 SVG 图标（扁平化渲染需要在创建时绑定）
  const svgIcon = folderContainer.querySelector("svg") as SVGElement | null
  if (svgIcon) {
    svgIcon.addEventListener("click", toggleFolder)
  }

  // 如果是 collapse 模式，也绑定到按钮
  if (opts.folderClickBehavior === "collapse") {
    const button = folderContainer.querySelector(".folder3-button") as HTMLElement | null
    if (button) {
      button.addEventListener("click", toggleFolder)
    }
  }

  return li
}

/**
 * 为扁平化结构创建节点元素（文件夹或文件）
 * @param flatNode - 扁平节点数据
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 * @returns 创建的 li 元素
 */
function createFlatNode(
  flatNode: FlatNode,
  currentSlug: FullSlug,
  opts: ParsedOptions,
): HTMLLIElement {
  const { node, level, index } = flatNode

  let li: HTMLLIElement

  if (node.isFolder) {
    // 创建简化版文件夹节点（不包含嵌套的子元素）
    li = createSimpleFolderNode(node, level, currentSlug, opts)
  } else {
    // 创建文件节点（使用已修改的 createFileNode）
    li = createFileNode(currentSlug, node, level)
  }

  // 设置扁平索引标记
  li.dataset.flatIndex = index.toString()

  return li
}

/**
 * 定位到当前文件：展开所有父级文件夹并滚动到文件位置
 * 由定位按钮触发，调用 navigateToFile 实现
 */
function locateCurrentFile() {
  if (!currentActiveSlug) {
    console.log(`%c[定位] 没有当前活跃文件`, "color: #ff8800")
    return
  }

  console.log(`%c[定位] 开始定位到: ${currentActiveSlug}`, "color: #00aaff; font-weight: bold")

  // 设置导航锁定
  isNavigating = true
  navigateToFile(currentActiveSlug)

  // 使用 requestIdleCallback 在浏览器空闲时解锁
  const unlockNavigating = () => {
    isNavigating = false
    console.log(`%c[定位] 浏览器空闲，导航锁定已解除`, "color: #00cc88")
  }

  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(unlockNavigating, { timeout: 2000 })
  } else {
    setTimeout(unlockNavigating, 500)
  }
}

// 默认文件项高度（px）
// 注意：此值必须与 explorer3.scss 中的 li 高度 (28px) 保持一致
// 如果修改此处，请同步修改 explorer3.scss 中的 li { height: 28px }
const DEFAULT_ITEM_HEIGHT = 38

/**
 * 祖先目录 → 展开键（= 真实文件夹的 slug，形如 `<目录>/index`）。
 *
 * 展开状态与 trie 的门控都按文件夹 slug（带 `/index`）记；而由「当前页面 slug」逐段拼出来的
 * 祖先路径是**不带** `/index` 的（如内容页 `任务/a` → `任务`）→ 永远命中不了，
 * 于是打开内容页时所在目录不会自动展开。这里做一次映射把两者对齐。
 */
function folderKeyIndex(validFolders: Set<string>): Map<string, string> {
  const index = new Map<string, string>()
  for (const path of validFolders) index.set(path.replace(/\/index$/, ""), path)
  return index
}

// ========== 步骤 2：状态管理函数 ==========

/**
 * 从 localStorage 加载展开状态
 */
/**
 * 从 localStorage 加载展开状态
 * 统一使用 string[] 格式
 */
/**
 * 从 sessionStorage 加载展开状态
 * 统一使用 string[] 格式
 */
function loadExpandedState(): Set<string> {
  const stored = sessionStorage.getItem("expandedFolders")
  if (!stored) return new Set()

  try {
    const parsed = JSON.parse(stored)
    if (Array.isArray(parsed) && (parsed.length === 0 || typeof parsed[0] === "string")) {
      return new Set(parsed)
    }
  } catch (e) {
    console.error("[loadExpandedState] 解析错误", e)
  }
  return new Set()
}

/**
 * 保存展开状态到 sessionStorage
 * 统一使用 string[] 格式
 */
function saveExpandedState() {
  const expandedArray = Array.from(expandedFolders)
  sessionStorage.setItem("expandedFolders", JSON.stringify(expandedArray))
  console.log(
    `%c[saveExpandedState] 保存状态: ${expandedArray.length} 个展开文件夹`,
    "color: #00ff00",
  )
}

// ========== 步骤 1：扁平化数据层函数 ==========

/**
 * 将树形结构转换为扁平数组
 * @param node - 当前节点
 * @param level - 当前层级深度
 * @param parentPath - 父级路径
 * @param result - 结果数组
 * @returns 扁平化节点数组
 */
function flattenTree(
  node: FileTrieNode,
  level: number,
  parentPath: string,
  result: FlatNode[] = [],
): FlatNode[] {
  const flatNode: FlatNode = {
    node,
    level,
    parentPath,
    index: result.length,
  }

  result.push(flatNode)

  // 只在文件夹展开时递归子节点（维度字段节点用 expandKey 区分「同字段挂在不同目录」）
  const expandKey = (node as unknown as { expandKey?: string }).expandKey ?? node.slug
  if (node.isFolder && expandedFolders.has(expandKey)) {
    node.children.forEach((child) => {
      flattenTree(child, level + 1, node.slug, result)
    })
  }

  return result
}

/**
 * 扁平化树形结构的入口函数
 * @param trie - 文件树根节点
 * @returns 扁平化节点数组
 */
function flattenTreeRoot(trie: FileTrieNode): FlatNode[] {
  const result: FlatNode[] = []
  trie.children.forEach((child) => {
    flattenTree(child, 0, "", result)
  })
  return result
}

/**
 * TODO 用于计算吸顶效果
 * 获取目标节点的所有父级目录索引
 * @param nodes - 扁平化节点数组
 * @param targetNode - 目标节点
 * @returns 父级节点的索引数组（从子到父排序）
 */
// function getAllParents(nodes: FlatNode[], targetNode: FlatNode | undefined): number[] {
//   if (!targetNode) return []

//   const parents: number[] = []
//   const targetLevel = targetNode.level

//   // 从目标节点向前查找所有父级
//   for (let i = targetNode.index - 1; i >= 0; i--) {
//     const node = nodes[i]
//     if (node.node.isFolder && node.level < targetLevel) {
//       parents.push(i)
//       if (node.level === 0) break // 到达根级停止
//     }
//   }

//   return parents
// }

/**
 * 获取视窗内的节点索引
 * @param nodes - 扁平化节点数组
 * @param viewport - 视窗范围 { start, end }
 * @returns 视窗内节点的索引数组
 */
// function getNodesInViewport(
//   nodes: FlatNode[],
//   viewport: { start: number; end: number },
// ): number[] {
//   const result: number[] = []
//   for (let i = viewport.start; i < Math.min(viewport.end, nodes.length); i++) {
//     result.push(i)
//   }
//   return result
// }

/**
 * 计算最终渲染范围：视窗内节点 + 活跃文件的父级目录
 * @param nodes - 扁平化节点数组
 * @param activeSlug - 当前活跃文件的 slug
 * @param viewport - 视窗范围
 * @returns 应该渲染的节点索引数组（已排序）
 */
// function calculateRenderRange(
//   nodes: FlatNode[],
//   activeSlug: string,
//   viewport: { start: number; end: number },
// ): number[] {
//   // 1. 找到活跃文件及其所有父级目录
//   const activeNode = nodes.find((n) => n.node.slug === activeSlug && !n.node.isFolder)
//   const requiredParents = getAllParents(nodes, activeNode)

//   // 2. 找到视窗内的节点
//   const visibleNodes = getNodesInViewport(nodes, viewport)

//   // 3. 合并渲染范围：视窗内节点 + 活跃文件的父级目录
//   const renderSet = new Set([...visibleNodes, ...requiredParents])

//   // 返回排序后的索引数组
//   return Array.from(renderSet).sort((a, b) => a - b)
// }

// ========== 步骤 5：吸顶效果相关函数 ==========

/**
 * 文件夹范围：记录每个文件夹在 flatNodes 中的起止索引
 */
// interface FolderRange {
//   start: number // 文件夹标题在 flatNodes 中的索引
//   end: number // 最后一个子节点的索引
//   folderSlug: string // 文件夹 slug
//   level: number // 层级深度
// }

// let folderRanges: Map<string, FolderRange> = new Map()

/**
 * 计算所有文件夹的范围
 * @param nodes - 扁平化节点数组
 * @returns 文件夹范围 Map
 */
// function calculateFolderRanges(nodes: FlatNode[]): Map<string, FolderRange> {
//   const ranges = new Map<string, FolderRange>()

//   for (let i = 0; i < nodes.length; i++) {
//     const node = nodes[i]
//     if (node.node.isFolder) {
//       const folderSlug = node.node.slug
//       let end = i

//       // 找到该文件夹的最后一个子节点
//       for (let j = i + 1; j < nodes.length; j++) {
//         if (nodes[j].level <= node.level) break
//         end = j
//       }

//       ranges.set(folderSlug, {
//         start: i,
//         end,
//         folderSlug,
//         level: node.level,
//       })
//     }
//   }

//   return ranges
// }

/**
 * 计算应该吸顶的文件夹索引
 * @param nodes - 扁平化节点数组
 * @param ranges - 文件夹范围 Map
 * @param viewportStart - 视窗起始索引
 * @param viewportEnd - 视窗结束索引
 * @returns 应该吸顶的文件夹索引数组（按层级排序，level 小的在前）
 */
// function calculateStickyFolders(
//   nodes: FlatNode[],
//   ranges: Map<string, FolderRange>,
//   viewportStart: number,
//   _viewportEnd: number, // 保留供将来使用
// ): number[] {
//   const stickyIndices: number[] = []

//   for (const [, range] of ranges) {
//     // 条件1: 文件夹标题已经滚出视窗顶部（start < viewportStart）
//     // 条件2: 文件夹的内容还在视窗内（end >= viewportStart）
//     if (range.start < viewportStart && range.end >= viewportStart) {
//       stickyIndices.push(range.start)
//     }
//   }

//   // 按层级排序：level 小的在前（顶部），level 大的在后（靠近内容）
//   stickyIndices.sort((a, b) => nodes[a].level - nodes[b].level)

//   return stickyIndices
// }

// ========== 步骤 4：单滚动条虚拟滚动函数 ==========

/**
 * 使用扁平化数据渲染 Explorer
 * @param explorerUl - Explorer 的 ul 容器
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 * @param scrollTop - 当前滚动位置（用于计算初始渲染范围）
 */
function renderFlatExplorer(
  explorerUl: Element,
  currentSlug: FullSlug,
  opts: ParsedOptions,
  scrollTop: number = 0,
) {
  console.log('[renderFlatExplorer] 渲染文件夹树');

  // 清空现有内容
  explorerUl.innerHTML = ""

  const totalCount = flatNodes.length
  const windowSize = opts.virtualScrollWindowSize || 50
  const buffer = Math.floor(windowSize / 4)

  // 根据滚动位置计算初始渲染范围
  const scrollBasedStart = Math.floor(scrollTop / DEFAULT_ITEM_HEIGHT)
  flatRenderStart = Math.max(0, scrollBasedStart - buffer)
  flatRenderEnd = Math.min(totalCount, flatRenderStart + windowSize)

  // 确保至少渲染 windowSize 个节点
  if (flatRenderEnd - flatRenderStart < windowSize) {
    if (flatRenderStart === 0) {
      flatRenderEnd = Math.min(windowSize, totalCount)
    } else if (flatRenderEnd === totalCount) {
      flatRenderStart = Math.max(0, totalCount - windowSize)
    }
  }



  console.log(
    `%c[renderFlatExplorer] 滚动位置: ${scrollTop}, 渲染范围: [${flatRenderStart}, ${flatRenderEnd})`,
    "color: #00ff00; font-weight: bold",
  )

  // 创建吸顶容器（仅在启用时创建）
  // if (opts.stickyHeaders) {
  //   const stickyContainer = document.createElement("div")
  //   stickyContainer.className = "sticky-headers"
  //   explorerUl.appendChild(stickyContainer)
  // }

  // 创建顶部占位元素
  const topSpacer = document.createElement("div")
  topSpacer.className = "virtual-spacer-top"
  topSpacer.style.height = `${flatRenderStart * DEFAULT_ITEM_HEIGHT}px`
  explorerUl.appendChild(topSpacer)

  // 渲染初始节点
  const fragment = document.createDocumentFragment()
  for (let i = flatRenderStart; i < flatRenderEnd; i++) {
    const li = createFlatNode(flatNodes[i], currentSlug, opts)
    fragment.appendChild(li)
  }
  explorerUl.appendChild(fragment)

  // 创建底部占位元素
  const bottomSpacer = document.createElement("div")
  bottomSpacer.className = "virtual-spacer-bottom"
  bottomSpacer.style.height = `${(totalCount - flatRenderEnd) * DEFAULT_ITEM_HEIGHT}px`
  explorerUl.appendChild(bottomSpacer)

  // 重要：确保当前活动的节点及其祖先高亮（扁平化结构下需要显式设置样式）
  const activeLink = explorerUl.querySelector(`a[data-for="${currentSlug}"]`)
  if (activeLink) {
    highlightPath(activeLink)
  } else if (opts.hideFiles) {
    // 隐藏末级文件模式下，高亮当前文件的祖先文件夹
    highlightAncestorFolders(explorerUl, currentSlug)
  }
}

/**
 * 刷新扁平化 Explorer（用于展开/折叠后重新渲染）
 * 使用全局的 currentTrie 和 currentExplorerUl
 */
function refreshFlatExplorer() {
  if (!currentTrie || !currentExplorerUl || !globalOpts || !currentActiveSlug) {
    console.warn("[refreshFlatExplorer] 缺少必要的全局引用")
    return
  }

  // 1. 记录当前滚动位置
  const scrollTop = (currentExplorerUl as HTMLElement).scrollTop

  // 2. 重新扁平化树（使用更新后的 expandedFolders）
  flatNodes = flattenTreeRoot(currentTrie)

  console.log(
    `%c[refreshFlatExplorer] 重新扁平化: ${flatNodes.length} 个节点, expandedFolders: ${expandedFolders.size}`,
    "color: #00ccff; font-weight: bold",
  )

  // 3. 重新渲染
  renderFlatExplorer(currentExplorerUl, currentActiveSlug, globalOpts, scrollTop)

  // 4. 重要：渲染完后立即恢复滚动位置（必须锁定 isNavigating 以防触发冗余 update）
  isNavigating = true
  currentExplorerUl.scrollTop = scrollTop
  setTimeout(() => {
    isNavigating = false
  }, 50)
}

/**
 * 设置单滚动条虚拟滚动监听器
 * @param explorerUl - Explorer 的 ul 容器
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 */
function setupFlatVirtualScroll(
  explorerUl: Element,
  currentSlug: FullSlug,
  opts: ParsedOptions,
) {
  let ticking = false

  const handleScroll = () => {
    if (ticking || isNavigating) return
    ticking = true

    requestAnimationFrame(() => {
      updateFlatVirtualScroll(explorerUl as HTMLElement, currentSlug, opts)
      ticking = false
    })
  }

  explorerUl.addEventListener("scroll", handleScroll, { passive: true })
  window.addCleanup(() => explorerUl.removeEventListener("scroll", handleScroll))

  console.log(`%c[setupFlatVirtualScroll] 已注册单滚动条监听器`, "color: #aa00ff")
}

/**
 * 更新单滚动条虚拟滚动
 * @param explorerUl - Explorer 的 ul 容器
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 */
function updateFlatVirtualScroll(
  explorerUl: HTMLElement,
  currentSlug: FullSlug,
  opts: ParsedOptions,
) {
  if (isNavigating) return
  const windowSize = opts.virtualScrollWindowSize || 50
  const scrollTop = explorerUl.scrollTop
  const viewportHeight = explorerUl.clientHeight
  const totalCount = flatNodes.length

  // 计算当前可见范围
  const visibleStart = Math.floor(scrollTop / DEFAULT_ITEM_HEIGHT)
  const visibleEnd = Math.ceil((scrollTop + viewportHeight) / DEFAULT_ITEM_HEIGHT)

  // 计算新的渲染范围（加上缓冲区）
  const buffer = Math.floor(windowSize / 4)
  let newStart = Math.max(0, visibleStart - buffer)
  let newEnd = Math.min(totalCount, visibleEnd + buffer)

  // 确保至少渲染 windowSize 个节点
  if (newEnd - newStart < windowSize) {
    if (newStart === 0) {
      newEnd = Math.min(windowSize, totalCount)
    } else if (newEnd === totalCount) {
      newStart = Math.max(0, totalCount - windowSize)
    }
  }

  // 边界强制更新：当接近顶部或底部时，强制更新到边界值
  const atTop = scrollTop < DEFAULT_ITEM_HEIGHT * 2
  const atBottom = scrollTop + viewportHeight >= (totalCount - 2) * DEFAULT_ITEM_HEIGHT

  if (atTop && flatRenderStart !== 0) {
    newStart = 0
    newEnd = Math.min(windowSize, totalCount)
  } else if (atBottom && flatRenderEnd !== totalCount) {
    newEnd = totalCount
    newStart = Math.max(0, totalCount - windowSize)
  }

  // 如果范围没有明显变化，不更新（但边界情况除外）
  const threshold = Math.floor(buffer / 2)
  const needsBoundaryUpdate = (atTop && flatRenderStart !== 0) || (atBottom && flatRenderEnd !== totalCount)
  if (
    !needsBoundaryUpdate &&
    Math.abs(newStart - flatRenderStart) < threshold &&
    Math.abs(newEnd - flatRenderEnd) < threshold
  ) {
    return
  }

  console.log(
    `%c[updateFlatVirtualScroll] 更新范围: [${flatRenderStart}, ${flatRenderEnd}) -> [${newStart}, ${newEnd})${needsBoundaryUpdate ? " (边界强制)" : ""}`,
    "color: #00cc88",
  )

  // 更新状态
  flatRenderStart = newStart
  flatRenderEnd = newEnd

  // 重新渲染
  rerenderFlatList(explorerUl, currentSlug, opts)

  // 更新吸顶文件夹（仅在启用时）
  // if (opts.stickyHeaders) {
  //   updateStickyHeaders(explorerUl, currentSlug, opts, visibleStart)
  // }
}

/**
 * 更新吸顶文件夹
 * @param explorerUl - Explorer 的 ul 容器
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 * @param viewportStart - 视窗起始索引
 */
// function updateStickyHeaders(
//   explorerUl: HTMLElement,
//   currentSlug: FullSlug,
//   opts: ParsedOptions,
//   viewportStart: number,
// ) {
//   const stickyContainer = explorerUl.querySelector(".sticky-headers") as HTMLElement
//   if (!stickyContainer) return

//   // 计算应该吸顶的文件夹
//   const stickyIndices = calculateStickyFolders(
//     flatNodes,
//     folderRanges,
//     viewportStart,
//     viewportStart + Math.ceil(explorerUl.clientHeight / DEFAULT_ITEM_HEIGHT),
//   )

//   // 如果没有需要吸顶的文件夹，清空容器
//   if (stickyIndices.length === 0) {
//     stickyContainer.innerHTML = ""
//     stickyContainer.style.display = "none"
//     return
//   }

//   // 检查是否需要更新（比较当前吸顶的文件夹索引）
//   const currentStickyIndices = Array.from(stickyContainer.querySelectorAll("[data-flat-index]"))
//     .map((el) => parseInt((el as HTMLElement).dataset.flatIndex || "-1"))

//   if (
//     currentStickyIndices.length === stickyIndices.length &&
//     currentStickyIndices.every((idx, i) => idx === stickyIndices[i])
//   ) {
//     return // 无需更新
//   }

//   // 清空并重新渲染吸顶文件夹
//   stickyContainer.innerHTML = ""
//   stickyContainer.style.display = "block"

//   const fragment = document.createDocumentFragment()
//   for (const idx of stickyIndices) {
//     const flatNode = flatNodes[idx]
//     const li = createFlatNode(flatNode, currentSlug, opts)
//     li.classList.add("sticky-header")
//     fragment.appendChild(li)
//   }
//   stickyContainer.appendChild(fragment)
// }

/**
 * 重新渲染扁平化列表
 * @param explorerUl - Explorer 的 ul 容器
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 */
function rerenderFlatList(
  explorerUl: HTMLElement,
  currentSlug: FullSlug,
  opts: ParsedOptions,
) {
  const totalCount = flatNodes.length

  // 更新顶部占位
  const topSpacer = explorerUl.querySelector(".virtual-spacer-top") as HTMLElement
  if (topSpacer) {
    topSpacer.style.height = `${flatRenderStart * DEFAULT_ITEM_HEIGHT}px`
  }

  // 更新底部占位
  const bottomSpacer = explorerUl.querySelector(".virtual-spacer-bottom") as HTMLElement
  if (bottomSpacer) {
    bottomSpacer.style.height = `${(totalCount - flatRenderEnd) * DEFAULT_ITEM_HEIGHT}px`
  }

  // 移除现有的节点（保留占位元素）
  const existingItems = explorerUl.querySelectorAll("li[data-flat-index]")
  existingItems.forEach((item) => item.remove())

  // 渲染新范围的节点
  const fragment = document.createDocumentFragment()
  for (let i = flatRenderStart; i < flatRenderEnd; i++) {
    const li = createFlatNode(flatNodes[i], currentSlug, opts)
    fragment.appendChild(li)
  }

  // 插入到顶部占位之后
  if (topSpacer) {
    topSpacer.after(fragment)
  }

  console.log(`%c[rerenderFlatList] 重新渲染完成`, "color: #00ff00")
}

/**
 * 清除所有高亮状态
 */
function clearHighlight() {
  const activeElements = document.querySelectorAll(".explorer3 .active")
  activeElements.forEach((el) => el.classList.remove("active"))

  const pathElements = document.querySelectorAll(".explorer3 .in-active-path")
  pathElements.forEach((el) => el.classList.remove("in-active-path"))
}

/**
 * 高亮目标元素及其父级路径
 * @param targetElement - 目标元素
 */
function highlightPath(targetElement: Element) {
  clearHighlight()
  targetElement.classList.add("active")

  // 向上查找并高亮父级文件夹
  let parent = targetElement.closest("li")
  while (parent) {
    parent.classList.add("in-active-path")
    parent = parent.parentElement?.closest("li") || null
  }
}

/**
 * 隐藏末级文件模式下：高亮当前文件的所有祖先文件夹
 * （文件节点已被过滤掉，无法通过 a[data-for] 定位目标，改为按路径找文件夹 li）
 */
function highlightAncestorFolders(explorerUl: Element, currentSlug: FullSlug) {
  clearHighlight()
  const parts = currentSlug.split("/")
  for (let i = 1; i < parts.length; i++) {
    const folderSlug = (parts.slice(0, i).join("/") + "/index") as FullSlug
    const idx = flatNodes.findIndex((fn) => fn.node.isFolder && fn.node.slug === folderSlug)
    if (idx === -1) continue
    explorerUl.querySelector(`li[data-flat-index="${idx}"]`)?.classList.add("in-active-path")
  }
}

/**
 * 定位到指定文件（扁平化版本）
 * @param targetSlug - 目标文件的 slug
 * @returns 是否成功定位
 */
function navigateToFile(targetSlug: FullSlug): boolean {
  // 找到目标文件在 flatNodes 中的索引
  const targetIndex = flatNodes.findIndex(
    (fn) => fn.node.slug === targetSlug && !fn.node.isFolder,
  )

  if (targetIndex === -1) {
    console.log(`%c[导航定位] 未找到目标文件: ${targetSlug}`, "color: #ff0000")
    return false
  }

  // 确保目标文件的所有父级文件夹都展开
  const targetNode = flatNodes[targetIndex]
  let needsRefresh = false

  // 向前查找所有父级文件夹并展开
  for (let i = targetIndex - 1; i >= 0; i--) {
    const node = flatNodes[i]
    if (node.node.isFolder && node.level < targetNode.level) {
      if (!expandedFolders.has(node.node.slug)) {
        expandedFolders.add(node.node.slug)
        needsRefresh = true
      }
      if (node.level === 0) break
    }
  }

  if (needsRefresh) {
    saveExpandedState()
    refreshFlatExplorer()
  }

  // 找到目标元素并滚动
  const targetLi = document.querySelector(`li[data-flat-index="${targetIndex}"]`)
  if (targetLi) {
    const targetLink = targetLi.querySelector("a")
    if (targetLink) {
      highlightPath(targetLink)
    } else {
      clearHighlight()
    }
    targetLi.scrollIntoView({ behavior: "instant", block: "center" })
    console.log(`%c[导航定位] 已定位到: ${targetSlug}`, "color: #00cc88")
    return true
  }

  return false
}

/**
 * 清除资源管理器的所有缓存数据
 */
function clearExplorerCache() {
  const cacheKeys = [
    "explorer3Html",
    "explorer3ScrollTop",
    "explorer3RenderStart",
    "explorer3RenderEnd",
    "expandedFolders",
  ]
  cacheKeys.forEach((key) => sessionStorage.removeItem(key))
  console.log("%c[clearExplorerCache] 缓存已清除", "color: #ff4444; font-weight: bold")
}

/**
 * 封装文件树初始化逻辑：获取数据 -> 构建 Trie -> 应用变换
 * 被全量渲染和缓存注水路径共同调用，方便统一调试性能。
 */
async function initializeFileTree(opts: ParsedOptions): Promise<FileTrieNode> {
  performance.mark("initializeFileTree-start")

  performance.mark("fetchData-start")
  const data = await fetchData
  performance.mark("fetchData-end")

  performance.mark("buildTrie-start")
  const entries = Object.entries(data) as unknown as [FullSlug, ContentIndexEntry][]
  const trie = FileTrieNode.fromEntries(entries)
  if (opts.hideFiles) {
    // 隐藏末级文件：只保留文件夹节点（当前文件的祖先文件夹在渲染时仍会高亮）
    trie.filter((node) => node.isFolder)
  }
  performance.mark("buildTrie-end")

  performance.mark("filterMapSort-start")
  for (const fn of opts.order) {
    switch (fn) {
      case "filter": if (opts.filterFn) trie.filter(opts.filterFn); break
      case "map": if (opts.mapFn) trie.map(opts.mapFn); break
      case "sort": if (opts.sortFn) trie.sort(opts.sortFn); break
    }
  }
  performance.mark("filterMapSort-end")

  // 动态分类：把「维度 → 取值」作为虚拟子节点挂到目录上。
  // 依赖站点级产物（static/aggregation.json + graph/dimensions/index.json），缺失时静默跳过。
  if (opts.dimensionFolders) {
    const dimensionEntries: DimensionEntry[] = entries
      .filter(([, entry]) => !(entry as { frontmatter?: { virtualNode?: unknown } }).frontmatter?.virtualNode)
      .map(([slug, entry]) => ({
        slug,
        frontmatter: (entry as { frontmatter?: Record<string, unknown> }).frontmatter,
      }))
    const injected = await injectDimensionNodes(trie, dimensionEntries, opts)
    if (injected > 0) console.log(`[explorer3] 动态分类：注入 ${injected} 个维度字段节点`)
  }

  performance.mark("initializeFileTree-end")
  performance.measure("initializeFileTree-total", "initializeFileTree-start", "initializeFileTree-end")

  return trie
}

/**
 * 从缓存恢复 Explorer UI
 */
function restoreFromCache(explorerUl: Element, currentSlug: FullSlug) {
  explorerUl.innerHTML = sessionStorage.getItem("explorer3Html") || ""
  explorerUl.scrollTop = parseInt(sessionStorage.getItem("explorer3ScrollTop") || "0")
  flatRenderStart = parseInt(sessionStorage.getItem("explorer3RenderStart") || "0")
  flatRenderEnd = parseInt(sessionStorage.getItem("explorer3RenderEnd") || "0")

  // 这里的 explorer3ExpandedFolders 已经废弃，应该通过 loadExpandedState 加载 expandedFolders
  // 但为了兼容 prenav 中可能保存的状态，如果在同一会话中，
  // 只要 expandedFolders 是正确保存的，这里可以留空，
  // 因为 setupExplorer3 后续会调用 loadExpandedState。
  // expandedFolders 初始化留给 setupExplorer3 处理。
  expandedFolders = new Set()

  // 更新 active 状态
  const currentLink = explorerUl.querySelector(`a[data-for="${currentSlug}"]`)
  if (currentLink) {
    highlightPath(currentLink)
  } else if (globalOpts?.hideFiles) {
    highlightAncestorFolders(explorerUl, currentSlug)
  } else {
    clearHighlight()
  }

  console.log("[restoreFromCache] 恢复完成")
}

function bindEvents(explorer: HTMLElement, opts: ParsedOptions) {
  // 定位按钮事件
  const locateBtn = explorer.querySelector(".locate-current-btn")
  if (locateBtn) {
    locateBtn.addEventListener("click", locateCurrentFile)
    window.addCleanup(() => locateBtn.removeEventListener("click", locateCurrentFile))
  }

  // 展开/折叠面板按钮
  const explorerButtons = explorer.getElementsByClassName(
    "explorer3-toggle",
  ) as HTMLCollectionOf<HTMLElement>
  for (const button of explorerButtons) {
    button.addEventListener("click", toggleExplorer)
    window.addCleanup(() => button.removeEventListener("click", toggleExplorer))
  }

  // 文件夹点击按钮（collapse 模式）
  if (opts.folderClickBehavior === "collapse") {
    const folderButtons = explorer.getElementsByClassName(
      "folder3-button",
    ) as HTMLCollectionOf<HTMLElement>
    for (const button of folderButtons) {
      button.addEventListener("click", toggleFolder)
      window.addCleanup(() => button.removeEventListener("click", toggleFolder))
    }
  }

  // 文件夹图标点击
  const folderIcons = explorer.getElementsByClassName(
    "folder3-icon",
  ) as HTMLCollectionOf<HTMLElement>
  for (const icon of folderIcons) {
    icon.addEventListener("click", toggleFolder)
    window.addCleanup(() => icon.removeEventListener("click", toggleFolder))
  }
}

/**
 * 初始化 Explorer3 组件
 * 核心入口函数，在每次 nav 事件时调用
 * 负责：解析配置、恢复状态、构建文件树、绑定事件
 * 注意：每次导航都会重新执行，需要处理好状态清理和复用
 * @param currentSlug - 当前页面的 slug
 */
async function setupExplorer3(currentSlug: FullSlug) {
  console.log("[setupExplorer3] Setting up explorer for slug:", currentSlug)

  performance.mark("setupExplorer3-start")

  const allExplorers = document.querySelectorAll("div.explorer3") as NodeListOf<HTMLElement>

  for (const explorer of allExplorers) {
    // 读取 basePath（支持子路径部署）
    basePath = explorer.dataset.basepath || ""
    console.log("[setupExplorer3] basePath:", basePath)

    const dataFns = JSON.parse(explorer.dataset.dataFns || "{}")
    const opts: ParsedOptions = {
      folderClickBehavior: (explorer.dataset.behavior || "collapse") as "collapse" | "link",
      folderDefaultState: (explorer.dataset.collapsed || "collapsed") as "collapsed" | "open",
      useSavedState: explorer.dataset.savestate === "true",
      virtualScrollWindowSize: parseInt(explorer.dataset.virtualscrollwindowsize || "50"),
      hideFiles: explorer.dataset.hidefiles === "true",
      dimensionFolders: explorer.dataset.dimensionfolders === "true",
      dimensionMaxValues: parseInt(explorer.dataset.dimensionmaxvalues || "20", 10),
      dimensionMaxLevels: parseInt(explorer.dataset.dimensionmaxlevels || "2", 10),
      order: dataFns.order || ["filter", "map", "sort"],
      sortFn: new Function("return " + (dataFns.sortFn || "undefined"))(),
      filterFn: new Function("return " + (dataFns.filterFn || "undefined"))(),
      mapFn: new Function("return " + (dataFns.mapFn || "undefined"))(),
    }

    // 保存全局配置
    globalOpts = opts

    // 配置面板（aggregation-page-pro）改完顺序后派发事件：按新顺序重排目录树
    const onDimensionOrderChanged = () => {
      void regroupDimensionNodes(opts)
    }
    document.addEventListener(DIMENSION_ORDER_EVENT, onDimensionOrderChanged)
    window.addCleanup(() => document.removeEventListener(DIMENSION_ORDER_EVENT, onDimensionOrderChanged))

    // 复用预热好的 metadata promise（首次拿不到时用 "unknown" 兜底：
    // 同一次会话内仍视为一致，SPA 快速复用路径不受影响）
    const serverBuildTime = await getServerBuildTime()
    const cachedBuildTime = sessionStorage.getItem("explorer3LastBuildTime")

    if (cachedBuildTime !== serverBuildTime) {
      console.log(
        `%c[setupExplorer3] 构建时间不一致 (旧: ${cachedBuildTime}, 新: ${serverBuildTime})，正在清除缓存...`,
        "color: #ff8800; font-weight: bold",
      )
      clearExplorerCache()
      sessionStorage.setItem("explorer3LastBuildTime", serverBuildTime)
    }

    // SPA 模式极致优化：如果 Trie 已经在内存中且构建时间一致，直接复用
    if (currentTrie && cachedBuildTime === serverBuildTime) {
      console.log("%c[setupExplorer3] 进入 SPA 快速复用路径", "color: #00ccff; font-weight: bold")

      const trie = currentTrie
      const validFolders = new Set(trie.getFolderPaths())
      const folderKeys = folderKeyIndex(validFolders)

      // 1. 自动展开当前路径的父文件夹
      const currentPathParts = currentSlug.split("/")
      let modifiedExpanded = false
      for (let i = 1; i <= currentPathParts.length; i++) {
        const ancestorPath = currentPathParts.slice(0, i).join("/")
        const folderKey = folderKeys.get(ancestorPath)
        if (folderKey && !expandedFolders.has(folderKey)) {
          expandedFolders.add(folderKey)
          modifiedExpanded = true
        }
      }

      if (modifiedExpanded && opts.useSavedState) saveExpandedState()

      const explorerUl = explorer.querySelector(".explorer3-ul") as HTMLElement
      if (explorerUl) {
        // 更新全局活跃 UI 引用
        currentExplorerUl = explorerUl
        currentActiveSlug = currentSlug

        // 2. 只有在展开状态改变或 flatNodes 为空时才重新扁平化
        if (modifiedExpanded || !flatNodes || flatNodes.length === 0) {
          flatNodes = flattenTreeRoot(currentTrie)
        }

        // 3. 从持久化缓存还原滚动位置（SPA 跳转后的新元素初始 scrollTop 为 0，必须用缓存）
        const savedScrollTop = parseInt(sessionStorage.getItem("explorer3ScrollTop") || "0")

        // 4. 刷新渲染（传入持久化的滚动位置以计算正确的虚拟渲染范围，防止 spacer-top 塌陷）
        renderFlatExplorer(explorerUl, currentSlug, opts, savedScrollTop)

        // 5. 重要：渲染完后立即显式恢复滚动位置（锁定 isNavigating 防止触发冗余 update）
        isNavigating = true
        explorerUl.scrollTop = savedScrollTop

        // 6. 重新高亮当前路径（确保 lineage 高亮同步）
        const activeLink = explorerUl.querySelector(`a[data-for="${currentSlug}"]`)
        if (activeLink) highlightPath(activeLink)
        else if (opts.hideFiles) highlightAncestorFolders(explorerUl, currentSlug)

        setTimeout(() => {
          isNavigating = false
        }, 100)

        // 7. 重新绑定虚拟滚动监听
        setupFlatVirtualScroll(explorerUl, currentSlug, opts)
      }

      bindEvents(explorer, opts)
      printPerformance()
      continue
    }

    const explorerUl = explorer.querySelector(".explorer3-ul")
    if (!explorerUl) continue

    const cachedHtml = sessionStorage.getItem("explorer3Html")
    const hasRealContentInCache = cachedHtml && cachedHtml.includes("data-flat-index")

    if (hasRealContentInCache) {
      // ========== 从缓存恢复 (F5 刷新后的快速展示路径) ==========
      console.log("[setupExplorer3] 从缓存恢复")
      restoreFromCache(explorerUl, currentSlug)
      performance.mark("restoreFromCache-end")

      const initExplorerAsync = async () => {
        const trie = await initializeFileTree(opts)
        currentTrie = trie
        currentExplorerUl = explorerUl

        const validFolders = new Set(trie.getFolderPaths())
        if (opts.useSavedState) {
          const loadedState = loadExpandedState()
          expandedFolders = new Set()
          loadedState.forEach(path => {
            if (validFolders.has(path as FullSlug)) expandedFolders.add(path)
          })
        }

        const currentPathParts = currentSlug.split("/")
        const folderKeys = folderKeyIndex(validFolders)
        for (let i = 1; i <= currentPathParts.length; i++) {
          const ancestorPath = currentPathParts.slice(0, i).join("/")
          const folderKey = folderKeys.get(ancestorPath)
          if (folderKey) expandedFolders.add(folderKey)
        }

        flatNodes = flattenTreeRoot(currentTrie)
        if (opts.useSavedState) saveExpandedState()

        setupFlatVirtualScroll(explorerUl, currentSlug, opts)
        isNavigating = false

        const total = performance.getEntriesByName("initializeFileTree-total").at(-1)?.duration?.toFixed(2) ?? "?"
        console.log(`%c[setupExplorer3] 异步初始化完成，Trie 构建耗时: ${total}ms`, "color: #00ff00; font-weight: bold")
      }

      // 使用 setTimeout 替代 requestIdleCallback，确保不被 MathJax 等重型组件长时间阻塞
      setTimeout(() => initExplorerAsync(), 0)
      bindEvents(explorer, opts)
      continue
    }

    // ========== 全量加载路径 ==========
    const trie = await initializeFileTree(opts)
    currentTrie = trie
    currentExplorerUl = explorerUl
    currentActiveSlug = currentSlug

    const validFolders = new Set(trie.getFolderPaths())
    if (opts.useSavedState && serverBuildTime == cachedBuildTime) {
      const loadedState = loadExpandedState()
      expandedFolders = new Set()
      loadedState.forEach(path => {
        if (validFolders.has(path as FullSlug)) expandedFolders.add(path)
      })
    } else {
      expandedFolders = new Set()
      if (opts.folderDefaultState === "open") {
        validFolders.forEach(path => expandedFolders.add(path))
      }
    }

    const currentPathParts = currentSlug.split("/")
    const folderKeys = folderKeyIndex(validFolders)
    for (let i = 1; i <= currentPathParts.length; i++) {
      const ancestorPath = currentPathParts.slice(0, i).join("/")
      const folderKey = folderKeys.get(ancestorPath)
      if (folderKey) expandedFolders.add(folderKey)
    }

    if (opts.useSavedState) saveExpandedState()

    flatNodes = flattenTreeRoot(currentTrie)

    // 设置全局引用（用于 refreshFlatExplorer）
    currentTrie = trie
    currentExplorerUl = explorerUl
    currentActiveSlug = currentSlug

    // ========== 扁平化渲染 ==========
    // 清空旧的占位元素
    if (!hasRealContentInCache) {
      console.log("不存在有效缓存，执行全量渲染。")

      const oldTopSpacer = explorerUl.querySelector(".virtual-spacer-top")
      const oldBottomSpacer = explorerUl.querySelector(".virtual-spacer-bottom")
      // const oldStickyHeaders = explorerUl.querySelector(".sticky-headers")
      if (oldTopSpacer) oldTopSpacer.remove()
      if (oldBottomSpacer) oldBottomSpacer.remove()
      // if (oldStickyHeaders) oldStickyHeaders.remove()

      // 获取保存的滚动位置（用于计算初始渲染范围）
      const savedScrollTop = sessionStorage.getItem("explorer3ScrollTop")
      const initialScrollTop = savedScrollTop ? parseInt(savedScrollTop) : 0

      // 使用扁平化数据渲染（传入滚动位置以计算正确的初始渲染范围）
      performance.mark("renderFlatExplorer-start")
      renderFlatExplorer(explorerUl, currentSlug, opts, initialScrollTop)
      performance.mark("renderFlatExplorer-end")


      // 恢复滚动位置
      if (savedScrollTop) {
        explorerUl.scrollTop = initialScrollTop
      }
    }

    // 设置单滚动条虚拟滚动监听
    setupFlatVirtualScroll(explorerUl, currentSlug, opts)

    // 首次加载时禁用虚拟滚动更新
    isNavigating = true
    const unlockNavigating = () => {
      isNavigating = false
    }
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(unlockNavigating, { timeout: 2000 })
    } else {
      setTimeout(unlockNavigating, 500)
    }

    bindEvents(explorer, opts)

    // 打印性能测量结果（无缓存路径）
    printPerformance()
  }
}

/**
 * 打印性能测量结果
 */
function printPerformance() {
  performance.mark("setupExplorer3-end")
  performance.measure("setupExplorer3-total", "setupExplorer3-start", "setupExplorer3-end")

  const measures = [
    { name: "fetchData", start: "fetchData-start", end: "fetchData-end" },
    { name: "buildTrie", start: "buildTrie-start", end: "buildTrie-end" },
    { name: "filterMapSort", start: "filterMapSort-start", end: "filterMapSort-end" },
    { name: "initializeFileTree", start: "initializeFileTree-start", end: "initializeFileTree-end" },
    { name: "renderFlatExplorer", start: "renderFlatExplorer-start", end: "renderFlatExplorer-end" },
  ]

  const total = performance.getEntriesByName("setupExplorer3-total").at(-1)?.duration?.toFixed(2) ?? "?"
  console.log(`%c[setupExplorer3] 总耗时: ${total}ms`, "color: #00ff00; font-weight: bold")

  for (const m of measures) {
    const entry = performance.getEntriesByName(m.name).at(-1)
    if (entry) {
      const percent = total !== "?" ? ((entry.duration / Number(total)) * 100).toFixed(1) : "?"
      console.log(`  - ${m.name}: ${entry.duration.toFixed(2)}ms (${percent}%)`)
    }
  }
}

// 脚本（页面）加载后立刻预热 metadata 请求：与 v4 页面注入的 fetchMetadata 等价，
// 这样首次导航时 promise 通常已 resolve，不会出现"等网络 → 侧栏空白"的闪烁。
if (typeof document !== "undefined") {
  const firstExplorer = document.querySelector("div.explorer3") as HTMLElement | null
  basePath = firstExplorer?.dataset.basepath || ""
  void getServerBuildTime()
}

// 步骤 4：保存滚动位置（参考 explorer2）
document.addEventListener("prenav", async () => {
  const explorerUl = document.querySelector(".explorer3-ul")
  if (!explorerUl) return
  // 保存各个数据到独立的 sessionStorage 键
  sessionStorage.setItem("explorer3Html", explorerUl.innerHTML)
  sessionStorage.setItem("explorer3ScrollTop", explorerUl.scrollTop.toString())
  sessionStorage.setItem("explorer3RenderStart", flatRenderStart.toString())
  sessionStorage.setItem("explorer3RenderEnd", flatRenderEnd.toString())
  console.log(`%c[prenav] 保存滚动位置: ${explorerUl.scrollTop}，渲染范围：${flatRenderStart}-${flatRenderEnd}`, "color: #888")
})

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const currentSlug = e.detail.url
  currentActiveSlug = currentSlug // 保存当前活跃文件
  console.log(`%c[NAV事件] 导航到: ${currentSlug}`, "color: #ff00ff; font-weight: bold")

  performance.mark("nav-start")

  await setupExplorer3(currentSlug)

  performance.mark("nav-end")
  performance.measure("nav-total", "nav-start", "nav-end")
  const navTotal = performance.getEntriesByName("nav-total").at(-1)?.duration?.toFixed(2) ?? "?"
  console.log(`%c[NAV事件] 总耗时: ${navTotal}ms`, "color: #ff00ff; font-weight: bold")

  for (const explorer of document.getElementsByClassName("explorer3")) {
    const mobileExplorer = explorer.querySelector(".mobile-explorer")
    if (!mobileExplorer) continue

    if (mobileExplorer.checkVisibility()) {
      explorer.classList.add("collapsed")
      explorer.setAttribute("aria-expanded", "false")
      document.documentElement.classList.remove("mobile-no-scroll")
    }

    mobileExplorer.classList.remove("hide-until-loaded")
  }
})

window.addEventListener("resize", function () {
  const explorer = document.querySelector(".explorer3")
  if (explorer && !explorer.classList.contains("collapsed")) {
    document.documentElement.classList.add("mobile-no-scroll")
    return
  }
})

