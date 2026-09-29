import { expect, it } from "vitest"
import { FileTrieNode } from "../src/util/fileTrie"

it("sorts each folder using its own inherited frontmatter field", () => {
  const root = FileTrieNode.fromEntries([
    ["notes/b" as any, { slug: "notes/b", title: "A", filePath: "notes/b.md", frontmatter: { priority: 10 } }],
    ["notes/a" as any, { slug: "notes/a", title: "B", filePath: "notes/a.md", frontmatter: { priority: 2 } }],
    ["other/b" as any, { slug: "other/b", title: "B", filePath: "other/b.md", frontmatter: { priority: 1 } }],
    ["other/a" as any, { slug: "other/a", title: "A", filePath: "other/a.md", frontmatter: { priority: 99 } }],
  ])
  root.sortByFolderFields({ default: "title", folders: { notes: "priority" } })
  expect(root.findNode(["notes"])?.children.map((child) => child.slugSegment)).toEqual(["a", "b"])
  expect(root.findNode(["other"])?.children.map((child) => child.slugSegment)).toEqual(["a", "b"])
})
