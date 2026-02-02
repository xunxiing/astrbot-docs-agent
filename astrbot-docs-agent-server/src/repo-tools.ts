import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { DynamicStructuredTool } from "@langchain/core/tools"
import { z } from "zod"

function resolveInside(rootDir: string, inputPath: string) {
  const clean = (inputPath || ".").replace(/^[/\\]+/, "")
  const rootAbs = path.resolve(rootDir)
  const abs = path.resolve(rootAbs, clean)
  if (abs === rootAbs) return { abs, rel: "." }
  if (!abs.startsWith(rootAbs + path.sep)) throw new Error(`Path escapes repo root: ${inputPath}`)
  return { abs, rel: path.relative(rootAbs, abs) || "." }
}

function isTextFileAllowed(relPath: string) {
  // Allow docs + VitePress config; disallow CI / deps.
  if (relPath.startsWith(".git" + path.sep) || relPath === ".git") return false
  if (relPath.startsWith(".github" + path.sep) || relPath === ".github") return false

  if (relPath.endsWith(".md") || relPath.endsWith(".mdx")) return true
  if (relPath.startsWith(".vitepress" + path.sep) || relPath === ".vitepress") {
    return relPath.endsWith(".js") || relPath.endsWith(".mjs") || relPath.endsWith(".ts") || relPath.endsWith(".json")
  }
  return false
}

export function createRepoTools(rootDir: string) {
  const listDirectory = new DynamicStructuredTool({
    name: "list_directory",
    description: "List entries in a directory (relative to repo root). Use this to explore the docs structure.",
    schema: z.object({
      path: z.string().default("."),
      maxEntries: z.number().int().min(1).max(500).default(200)
    }),
    func: async ({ path: inputPath, maxEntries }) => {
      const { abs, rel } = resolveInside(rootDir, inputPath)
      const entries = await readdir(abs, { withFileTypes: true })
      const items = entries
        .slice(0, maxEntries)
        .map((d) => ({
          name: d.name,
          type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other"
        }))
      return JSON.stringify({ path: rel, entries: items, truncated: entries.length > maxEntries }, null, 2)
    }
  })

  const readTextFile = new DynamicStructuredTool({
    name: "read_file",
    description: "Read a UTF-8 text file (relative to repo root). Returns truncated content if it's too large.",
    schema: z.object({
      path: z.string(),
      maxChars: z.number().int().min(200).max(200000).default(20000)
    }),
    func: async ({ path: inputPath, maxChars }) => {
      const { abs, rel } = resolveInside(rootDir, inputPath)
      const s = await stat(abs)
      if (!s.isFile()) throw new Error(`Not a file: ${rel}`)
      const content = await readFile(abs, "utf-8")
      const truncated = content.length > maxChars
      const out = truncated ? content.slice(0, maxChars) + "\n\n(…truncated)" : content
      return JSON.stringify({ path: rel, truncated, content: out }, null, 2)
    }
  })

  const writeTextFile = new DynamicStructuredTool({
    name: "write_file",
    description:
      "Create or overwrite a text file (relative to repo root). Allowed paths: *.md/*.mdx and .vitepress/*.js|.mjs|.ts|.json (no .github).",
    schema: z.object({
      path: z.string(),
      content: z.string()
    }),
    func: async ({ path: inputPath, content }) => {
      const { abs, rel } = resolveInside(rootDir, inputPath)
      if (!isTextFileAllowed(rel)) throw new Error(`Write blocked by allowlist: ${rel}`)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, content, "utf-8")
      return JSON.stringify({ ok: true, path: rel, bytes: Buffer.byteLength(content, "utf-8") }, null, 2)
    }
  })

  const findFiles = new DynamicStructuredTool({
    name: "find_files",
    description:
      "Recursively find files under a directory (relative to repo root). Use this to quickly list docs files without walking the whole repo manually.",
    schema: z.object({
      path: z.string().default("."),
      extensions: z.array(z.string()).default([".md", ".mdx"]),
      maxResults: z.number().int().min(1).max(2000).default(500),
      maxDepth: z.number().int().min(0).max(10).default(6)
    }),
    func: async ({ path: inputPath, extensions, maxResults, maxDepth }) => {
      const { abs, rel } = resolveInside(rootDir, inputPath)
      const rootAbs = path.resolve(rootDir)
      const results: string[] = []
      const stack: Array<{ dir: string; depth: number }> = [{ dir: abs, depth: 0 }]
      while (stack.length && results.length < maxResults) {
        const { dir, depth } = stack.pop()!
        let entries: any[]
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const d of entries) {
          if (results.length >= maxResults) break
          const name = Buffer.isBuffer(d.name) ? d.name.toString("utf-8") : String(d.name)
          const full = path.join(dir, name)
          const relPath = path.relative(rootAbs, full)
          if (d.isDirectory()) {
            if (depth < maxDepth && name !== ".git" && name !== "node_modules") stack.push({ dir: full, depth: depth + 1 })
            continue
          }
          if (!d.isFile()) continue
          if (!extensions.some((ext) => relPath.endsWith(ext))) continue
          results.push(relPath)
        }
      }
      return JSON.stringify({ path: rel, results, truncated: results.length >= maxResults }, null, 2)
    }
  })

  return [listDirectory, findFiles, readTextFile, writeTextFile]
}
