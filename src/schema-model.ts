/**
 * Schema/draft model helpers for the settings browser.
 *
 * Vendored from @deepseek-ai/dsh-client-schema-form (model.ts, MIT license,
 * Copyright DeepSeek — source: packages/client/schema-form in
 * deepseek-ai/deepseek-harness). That package is missing from the
 * npm-distributed dsh closure (its consumers declare it only as a workspace
 * peer; see deepseek-harness discussion #3471), and a static import of it
 * crashed plugin boot on every fresh npm-dsh install since 0.7.2. Only the
 * three helpers this plugin uses are kept; the runtime dependency is
 * @deepseek-ai/schemastery, which IS present in every dsh closure (npm and
 * Homebrew) and resolves through the usual closure contract.
 */

import Schema from '@deepseek-ai/schemastery'

/** Live schemastery node; the renderer reads only its structural relations. */
export type SchemaNode = Schema

/**
 * Rehydrate a serialized schema envelope into a live validator/node tree.
 * @param serialized - `schema.toJSON()` output received over the wire.
 * @returns the root schema node.
 */
export function rehydrateSchema(serialized: unknown): SchemaNode {
  return new Schema(serialized as Schema)
}

/**
 * Resolve the schema node at a settings path: object properties by name,
 * dict entries through `inner`. An unresolvable segment returns `undefined`
 * so the caller falls back instead of rendering a wrong subtree.
 * @param root - rehydrated section root node.
 * @param path - key path from the section root.
 * @returns the node describing that position, or `undefined`.
 */
export function nodeAtPath(root: SchemaNode, path: readonly string[]): SchemaNode | undefined {
  let node: SchemaNode | undefined = root
  for (const key of path) {
    if (node === undefined) return undefined
    if (node.type === 'object') node = (node.dict as Record<string, SchemaNode> | undefined)?.[key]
    else if (node.type === 'dict' || node.type === 'array') node = node.inner as SchemaNode | undefined
    else return undefined
  }
  return node
}

/**
 * Read a nested value by path.
 * @param value - root value (draft or fallback layer).
 * @param path - key path from the root; array indexes as strings.
 * @returns the value at the path, or `undefined` along a missing branch.
 */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current[Number(key)]
      continue
    }
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
