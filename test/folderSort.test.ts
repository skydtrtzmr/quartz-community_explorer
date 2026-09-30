import { expect, it } from "vitest"
import { FileTrieNode } from "../src/util/fileTrie"

it("sorts each folder using its own inherited frontmatter field", () => {
  const root = FileTrieNode.fromEntries([
    [
      "notes/b" as any,
      { slug: "notes/b", title: "A", filePath: "notes/b.md", frontmatter: { priority: 10 } },
    ],
    [
      "notes/a" as any,
      { slug: "notes/a", title: "B", filePath: "notes/a.md", frontmatter: { priority: 2 } },
    ],
    [
      "other/b" as any,
      { slug: "other/b", title: "B", filePath: "other/b.md", frontmatter: { priority: 1 } },
    ],
    [
      "other/a" as any,
      { slug: "other/a", title: "A", filePath: "other/a.md", frontmatter: { priority: 99 } },
    ],
  ])
  root.sortByFolderFields({
    default: { field: "title", order: "asc" },
    folders: { notes: { field: "priority", order: "asc" } },
  })
  expect(root.findNode(["notes"])?.children.map((child) => child.slugSegment)).toEqual(["a", "b"])
  expect(root.findNode(["other"])?.children.map((child) => child.slugSegment)).toEqual(["a", "b"])
})

it("inherits descending direction while keeping missing values last", () => {
  const root = FileTrieNode.fromEntries([
    [
      "notes/a" as any,
      { slug: "notes/a", title: "A", filePath: "notes/a.md", frontmatter: { priority: 2 } },
    ],
    [
      "notes/b" as any,
      { slug: "notes/b", title: "B", filePath: "notes/b.md", frontmatter: { priority: 10 } },
    ],
    ["notes/c" as any, { slug: "notes/c", title: "C", filePath: "notes/c.md", frontmatter: {} }],
  ])
  root.sortByFolderFields({
    default: { field: "title", order: "asc" },
    folders: { notes: { field: "priority", order: "desc" } },
  })
  expect(root.findNode(["notes"])?.children.map((child) => child.slugSegment)).toEqual([
    "b",
    "a",
    "c",
  ])
})

it("sorts text frontmatter fields descending", () => {
  const root = FileTrieNode.fromEntries([
    ["people/a" as any, { slug: "people/a", title: "A", filePath: "people/a.md", frontmatter: { name: "Alice" } }],
    ["people/b" as any, { slug: "people/b", title: "B", filePath: "people/b.md", frontmatter: { name: "Bob" } }],
  ])
  root.sortByFolderFields({ default: { field: "title", order: "asc" }, folders: { people: { field: "name", order: "desc" } } })
  expect(root.findNode(["people"])?.children.map((child) => child.slugSegment)).toEqual(["b", "a"])
})
