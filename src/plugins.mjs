const registered = [];

// Fuse.use: a plugin is a class with `static condition(pattern, options)` and `searchIn(text)`, which returns { isMatch, score, indices?, hasInverse? }.
// As in Fuse, the plugins come after the built-in searchers (extended search and token search take precedence) and the first whose condition holds is used.
export function registerPlugins(plugins) {
  for (const plugin of plugins) {
    if (typeof plugin?.condition !== "function") throw new TypeError("fuseter: a plugin must be a class with a static condition(pattern, options) method");
    registered.push(plugin);
  }
}

export const pluginFor = (pattern, options) => options.useExtendedSearch || options.useTokenSearch ? undefined : registered.find(plugin => plugin.condition(pattern, options));
