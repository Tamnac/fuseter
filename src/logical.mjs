
const AND = "$and", OR = "$or", PATH = "$path", VALUE = "$val";

const isExpression = query => Boolean(query[AND] || query[OR]);
const isObject = value => typeof value === "object" && value !== null;
const explicit = query => ({ [AND]: Object.keys(query).map(key => ({ [key]: query[key] })) });

// Fuse's logical query as a tree (parseQuery). A node is { operator, children }; a leaf is { keyId, pattern }, where keyId is the id of the key to search
// (null: all keys). An object with several keys, or without $and and $or, means the AND of its entries; a string is searched in every key.
export function parseLogical(query) {
  if (!isObject(query)) throw new TypeError("fuseter: the query must be a string or a logical query object");
  const next = query => {
    if (typeof query === "string") return { keyId: null, pattern: query };
    const keys = Object.keys(query), isPath = Boolean(query[PATH]);
    if (!isPath && keys.length > 1 && !isExpression(query)) return next(explicit(query));
    if (!isExpression(query)) {
      const key = isPath ? query[PATH] : keys[0], pattern = isPath ? query[VALUE] : query[key];
      if (typeof pattern !== "string") throw new TypeError(`fuseter: invalid logical query value for key '${key}'`);
      return { keyId: Array.isArray(key) ? key.join(".") : key, pattern };
    }
    const children = [];
    for (const key of keys) if (Array.isArray(query[key])) for (const child of query[key]) children.push(next(child));
    return { operator: keys[0], children };
  };
  return next(isExpression(query) ? query : explicit(query));
}

export function leavesOf(node) {
  return node.children ? node.children.flatMap(leavesOf) : [node];
}

// The matches of one document, in Fuse's order: `matchesOf(leaf)` lists those of a leaf. An AND node needs a match in every child, an OR node in at least one.
export function evaluateLogical(node, matchesOf) {
  if (!node.children) return matchesOf(node);
  const found = [];
  for (const child of node.children) {
    const matches = evaluateLogical(child, matchesOf);
    if (matches.length) found.push(...matches);
    else if (node.operator === AND) return [];
  }
  return found;
}
