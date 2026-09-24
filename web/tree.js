// A chat is a tree of messages: editing a message or retrying a reply adds a
// sibling instead of overwriting it, and the screen shows one branch of the tree
// (from the first message down to a "leaf"). ‹ 2/3 › switches between siblings.

const ROOT = '\u0000root'

export function createTree() {
  return { byId: new Map(), children: new Map() }
}

/** Builds a tree from rows sorted oldest first. `linear` = database without parent_id (each row follows the one before). */
export function treeFrom(rows, { linear = false } = {}) {
  const tree = createTree()
  let previous = null
  for (const row of rows) {
    if (linear) row.parent_id = previous?.id ?? null
    addMessage(tree, row)
    previous = row
  }
  return tree
}

/** Adds a saved message (one with an id). Siblings stay in the order they were added (= oldest first). */
export function addMessage(tree, message) {
  if (!message?.id || tree.byId.has(message.id)) return
  tree.byId.set(message.id, message)
  const key = message.parent_id ?? ROOT
  if (!tree.children.has(key)) tree.children.set(key, [])
  tree.children.get(key).push(message)
}

export function childrenOf(tree, id) {
  return tree.children.get(id ?? ROOT) ?? []
}

/** Other versions of this message: same parent, same role. Unsaved messages have none. */
export function siblingsOf(tree, message) {
  if (!message?.id || !tree.byId.has(message.id)) return [message]
  return childrenOf(tree, message.parent_id).filter((m) => m.role === message.role)
}

/** Follows the newest child all the way down. */
export function lastLeaf(tree, id) {
  let node = tree.byId.get(id)
  const seen = new Set()
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    const kids = childrenOf(tree, node.id)
    if (!kids.length) break
    node = kids[kids.length - 1]
  }
  return node ?? null
}

/** First message → `leafId`. */
export function pathTo(tree, leafId) {
  const out = []
  const seen = new Set()
  let node = tree.byId.get(leafId)
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    out.push(node)
    node = node.parent_id ? tree.byId.get(node.parent_id) : null
  }
  return out.reverse()
}

/** The branch to show: through `leafId` (the one viewed last) down to its newest end, else the newest message. */
export function branchFor(tree, leafId) {
  let start = leafId ? tree.byId.get(leafId) : null
  if (!start) {
    for (const message of tree.byId.values()) start = message // Map keeps insertion order: last = newest
  }
  if (!start) return []
  return pathTo(tree, lastLeaf(tree, start.id).id)
}
