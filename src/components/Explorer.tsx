import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types"
import style from "./styles/explorer-pro.scss"
// @ts-expect-error - inline script imported as string by esbuild loader
import script from "./scripts/explorer-pro.inline.ts"
import { classNames } from "../util/lang"
import { i18n } from "../i18n"
import type { FileTrieNode } from "../util/fileTrie"
import OverflowListFactory from "./OverflowList"
import type { SortConfig } from "../util/sort"
import { applySortDefaults } from "../util/sort"

// 拼接多个 afterDOMLoaded 脚本（v4 util/resources.concatenateResources 的本地实现）
function concatenateResources(...resources: (string | undefined)[]): string {
  return resources.filter((r): r is string => !!r).join("\n")
}

// 从 baseUrl 提取子路径（如 "http://127.0.0.1:8766/demo-core" -> "demo-core"）
function getBasePath(baseUrl: string | undefined): string {
  if (!baseUrl) return ""
  // 如果已经是完整 URL（含协议），直接解析提取 pathname
  if (baseUrl.includes("://")) {
    try {
      const url = new URL(baseUrl)
      return url.pathname === "/" ? "" : url.pathname.replace(/^\//, "")
    } catch {
      return ""
    }
  }
  // 不含协议但含 /（如 "localhost/demo-core" 或 "127.0.0.1:8766/demo-core"），
  // 补全 https:// 后用 URL 解析提取 pathname
  if (baseUrl.includes("/")) {
    try {
      const url = new URL(`https://${baseUrl}`)
      return url.pathname === "/" ? "" : url.pathname.replace(/^\//, "")
    } catch {
      // 解析失败，fall through
    }
  }
  // 否则作为纯路径返回（去掉开头和结尾的 /）
  return baseUrl.replace(/^\//, "").replace(/\/$/, "")
}

// ===== Explorer2 排序辅助函数 =====
// 生成自包含的 sortFn 代码字符串，用于序列化到浏览器端执行

/**
 * 生成自包含的排序函数代码
 * 返回的函数不依赖任何外部变量，可安全序列化
 */
function generateSortFnCode(config: SortConfig): string {
  const cfg = applySortDefaults(config)
  const multiplier = cfg.order === "asc" ? "1" : "-1"
  const { type, field = "title" } = cfg

  // 生成字符串字段提取代码
  function getStringValueCode(prefix: "a" | "b"): string {
    const node = prefix
    if (field === "title" || field === "displayName") {
      return `${node}.displayName`
    }
    if (field === "slug") {
      return `(${node}.slugSegment ?? "")`
    }
    // 其他字段从 data.frontmatter 中获取
    return `((${node}.data && ${node}.data.frontmatter && ${node}.data.frontmatter["${field}"]) ? String(${node}.data.frontmatter["${field}"]) : "")`
  }

  const valA = getStringValueCode("a")
  const valB = getStringValueCode("b")

  // 生成日期字段提取代码
  const dateValA = `(function(node) {
    var fm = node.data && node.data.frontmatter;
    var df = fm && fm["${field}"];
    if (df !== undefined && df !== null) {
      var dt = new Date(df);
      if (!isNaN(dt.getTime())) return dt;
      console.warn('[Explorer2] field ' + '${field}' + ' is not a date, fallback to dates.date');
    }
    var d = node.data && node.data.dates;
    if (d) {
      if (d.date) return d.date;
      return d.modified;
    }
    return null;
  })(a)`

  const dateValB = dateValA.replace(/\(a\)/g, "(b)")

  // 生成数值字段提取代码
  const numValA = `(function(node) {
    var fm = node.data && node.data.frontmatter;
    var raw = fm && fm["${field}"];
    if (raw !== undefined && raw !== null) {
      var n = Number(raw);
      if (!isNaN(n)) return n;
    }
    return 0;
  })(a)`

  const numValB = numValA.replace(/\(a\)/g, "(b)")

  let compareCode = ""

  switch (type) {
    case "date":
      compareCode = `
        var da = ${dateValA}, db = ${dateValB};
        if (da === null && db === null) return 0;
        if (da === null) return 1;
        if (db === null) return -1;
        var r = (da.getTime() - db.getTime()) * ${multiplier};
        if (r !== 0) return r;
        return a.displayName.localeCompare(b.displayName, undefined, {numeric: true, sensitivity: 'base'});
      `
      break
    case "numeric":
      compareCode = `
        var na = ${numValA}, nb = ${numValB};
        var r = (na - nb) * ${multiplier};
        if (r !== 0) return r;
        return a.displayName.localeCompare(b.displayName, undefined, {numeric: true, sensitivity: 'base'});
      `
      break
    case "natural":
      compareCode = `return ${valA}.localeCompare(${valB}, undefined, {numeric: true, sensitivity: 'base'}) * ${multiplier};`
      break
    case "lexical":
      compareCode = `return ${valA}.localeCompare(${valB}) * ${multiplier};`
      break
  }

  return `(function(a, b) {
    if (a.isFolder && !b.isFolder) return -1;
    if (!a.isFolder && b.isFolder) return 1;
    ${compareCode}
  })`
}

type OrderEntries = "sort" | "filter" | "map"

export interface Options {
  title?: string
  folderDefaultState: "collapsed" | "open"
  folderClickBehavior: "collapse" | "link"
  useSavedState: boolean
  // 虚拟滚动窗口大小：同时渲染的节点数量（默认 50）
  virtualScrollWindowSize: number
  // 隐藏末级文件：只显示文件夹（当前文件的祖先文件夹仍会高亮）
  hideFiles: boolean
  // 屏蔽路径前缀（相对内容根，如系统目录 `_dimensions`）：命中的节点整枝不显示
  excludePathPrefixes: string[]
  // 动态分类：在目录下挂「维度 → 取值」子节点（需站点配置了 configuration.aggregation）
  dimensionFolders: boolean
  // 动态分类：单字段最多展示的取值数（超出显示「… (N)」，点击进字段索引页）
  dimensionMaxValues: number
  // 排序配置（YAML options.sort 透传；按 frontmatter 字段排序依赖 content-index-pro 写入的 frontmatter）
  sort?: SortConfig
  sortFn: (a: FileTrieNode, b: FileTrieNode) => number
  filterFn: (node: FileTrieNode) => boolean
  mapFn: (node: FileTrieNode) => void
  order: OrderEntries[]
}

const defaultOptions: Options = {
  folderDefaultState: "collapsed",
  folderClickBehavior: "link",
  useSavedState: true,
  virtualScrollWindowSize: 50, // 每次渲染 50 个节点
  hideFiles: false,
  excludePathPrefixes: [],
  dimensionFolders: false,
  dimensionMaxValues: 20,
  mapFn: (node) => {
        return node
    },
    sortFn: (a, b) => {
        // Sort order: folders first, then files. Sort folders and files alphabetically
        if ((!a.isFolder && !b.isFolder) || (a.isFolder && b.isFolder)) {
            // numeric: true: Whether numeric collation should be used, such that "1" < "2" < "10"
            // sensitivity: "base": Only strings that differ in base letters compare as unequal. Examples: a ≠ b, a = á, a = A
            return a.displayName.localeCompare(b.displayName, undefined, {
                numeric: true,
                sensitivity: "base",
            })
        }

        if (!a.isFolder && b.isFolder) {
            return 1
        } else {
            return -1
        }
    },
    filterFn: (node) => node.slugSegment !== "tags",
    order: ["filter", "map", "sort"],
}

export type FolderState = {
    path: string
    collapsed: boolean
    // 虚拟滚动状态
    renderStart?: number
    renderEnd?: number
    fileCount?: number
}

let numExplorers = 0
export default ((userOpts?: Partial<Options>) => {
    const options: Options = {
        ...defaultOptions,
        ...userOpts,
    }

    // 如果传入了 sort 配置，生成自包含的 sortFn 代码字符串
    const sortFnCode = options.sort
        ? generateSortFnCode(options.sort)
        : options.sortFn.toString()

    // filterFn 是函数、无法直接由 YAML 表达，因此把「屏蔽路径前缀」**内联**进序列化代码：
    // 浏览器端执行同一份判断（插件运行时也是 new Function(序列化代码)）。
    const excludePathPrefixes = options.excludePathPrefixes ?? []
    const filterFnCode = `(function(node) {
  if (!(${options.filterFn.toString()})(node)) return false;
  var excludes = ${JSON.stringify(excludePathPrefixes)};
  for (var i = 0; i < excludes.length; i++) {
    if (String(node.slug).indexOf(excludes[i]) === 0) return false;
  }
  return true;
})`

    const { OverflowList, overflowListAfterDOMLoaded } = OverflowListFactory()

    const Explorer: QuartzComponent = ({ cfg, displayClass }: QuartzComponentProps) => {
        const id = `explorer3-${numExplorers++}`
        const basePath = getBasePath(cfg.baseUrl)

        return (
            <div
                class={classNames(displayClass, "explorer3")}
                data-behavior={options.folderClickBehavior}
                data-collapsed={options.folderDefaultState}
                data-savestate={options.useSavedState}
                data-virtualscrollwindowsize={options.virtualScrollWindowSize}
                data-hidefiles={options.hideFiles}
                data-dimensionfolders={String(options.dimensionFolders)}
                data-dimensionmaxvalues={String(options.dimensionMaxValues)}
                data-basepath={basePath}
                data-data-fns={JSON.stringify({
                    order: options.order,
                    sortFn: sortFnCode,
                    filterFn: filterFnCode,
                    mapFn: options.mapFn.toString(),
                })}
            >
                <button
                    type="button"
                    class="explorer3-toggle mobile-explorer hide-until-loaded"
                    data-mobile={true}
                    aria-controls={id}
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="lucide-menu"
                    >
                        <line x1="4" x2="20" y1="12" y2="12" />
                        <line x1="4" x2="20" y1="6" y2="6" />
                        <line x1="4" x2="20" y1="18" y2="18" />
                    </svg>
                </button>
                <button
                    type="button"
                    class="title-button explorer3-toggle desktop-explorer"
                    data-mobile={false}
                    aria-expanded={true}
                >
                    <h2>{options.title ?? i18n(cfg.locale ?? "en-US").components.explorer.title}</h2>
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="5 8 14 8"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="fold"
                    >
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
                <div id={id} class="explorer3-content" aria-expanded={false} role="group">
                    <OverflowList class="explorer3-ul" />
                    {/* TODO 暂时注释掉定位按钮，以后再做。 */}
                    {/* <button type="button" class="locate-current-btn" title="定位到当前文件">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                    </button> */}
                </div>
                <template id="template-file3">
                    <li>
                        <a href="#" class="file-link"></a>
                    </li>
                </template>
                <template id="template-folder3">
                    <li>
                        <div class="folder3-container">
                            <div>
                                <button class="folder3-button">
                                    <span class="folder3-content-wrapper">
                                        <span class="folder3-title"></span>
                                    </span>
                                </button>
                            </div>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                class="folder3-icon"
                            >
                                <polyline points="9 6 15 12 9 18"></polyline>
                            </svg>
                        </div>
                        <div class="folder3-outer">
                            <ul class="content"></ul>
                        </div>
                    </li>
                </template>
            </div>
        )
    }

    Explorer.css = style
    Explorer.afterDOMLoaded = concatenateResources(script, overflowListAfterDOMLoaded)
    return Explorer
}) satisfies QuartzComponentConstructor