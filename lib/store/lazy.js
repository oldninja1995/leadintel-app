/* Properties computed on first read, then kept.
 *
 * The entity snapshot is ~70MB of JSON across forty collections, and a cold
 * instance used to parse all of it before drawing a page that reads five.
 * Each collection is now decoded the first time something asks for it — see
 * lib/store/snapshot.js — and these are the two pieces that keep that true
 * once the set leaves the store.
 *
 * The trap is the object spread. `{ ...entities }` reads every property, so a
 * single copy anywhere on the request path decodes the whole set and the
 * saving silently disappears. Nothing breaks when that happens — figures stay
 * correct, the page just gets slow again — so copies of an entity set go
 * through `extend` instead.
 *
 * A lazy property is enumerable and reads like any other: `Object.keys`,
 * `JSON.stringify` and `deepEqual` all see the same object they always did,
 * they just force the decode on the way. */

/* `compute` runs at most once. The accessor replaces itself with a plain value
   on the first read, so later reads cost a property lookup, not a call. An
   assignment replaces it the same way, which keeps `out.x = …` meaning what it
   means on a plain object. */
function define(obj, key, compute) {
  const settle = (value) => {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
    return value;
  };
  Object.defineProperty(obj, key, {
    get() { return settle(compute()); },
    set(value) { settle(value); },
    enumerable: true,
    configurable: true,
  });
  return obj;
}

/* `{ ...base, ...extra }` without reading `base`. Each property of the copy
   reads through to `base` when first asked for, so a collection nobody on this
   request needs is never decoded. */
function extend(base, extra = {}) {
  const out = {};
  for (const key of Object.keys(base)) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) continue;
    const desc = Object.getOwnPropertyDescriptor(base, key);
    if (desc && 'value' in desc) out[key] = desc.value;
    else define(out, key, () => base[key]);
  }
  return Object.assign(out, extra);
}

module.exports = { define, extend };
