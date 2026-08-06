/* The static implementation of the read API.
 *
 * This is the only file in the app that reaches into `data/`. It answers from
 * the modules the converter emits (`data/generated/<resource>.js`) with the
 * authored overrides layered on top (`data/<resource>.js`), which is the
 * arrangement Phase 1 established: a converter re-run replaces the generated
 * layer without touching hand-written content.
 *
 * When a real datastore arrives it becomes a sibling of this file, not a
 * rewrite of it — see contract.js.
 */

const fs = require('fs');
const path = require('path');

const { assertImplements } = require('./contract');

const DATA = path.join(__dirname, '..', '..', 'data');

class StaticRepository {
  constructor() {
    this.name = 'static';
    /* Required lazily so a syntax error in one data module cannot stop the
       whole app from booting — the screen that reads it fails instead. */
    this._screens = null;
  }

  _registry() {
    if (!this._screens) this._screens = require(path.join(DATA, 'screens'));
    return this._screens;
  }

  _module(dir, resource) {
    const file = path.join(DATA, dir, `${resource}.js`);
    return fs.existsSync(file) ? require(file) : null;
  }

  async screens() {
    return this._registry().SCREENS;
  }

  async navigation(activeSlug) {
    return this._registry().navGroups(activeSlug);
  }

  async subviewGroups(view) {
    const all = require(path.join(DATA, 'generated', '_subviews.json'));
    return all[view] || [];
  }

  async resources() {
    return fs
      .readdirSync(path.join(DATA, 'generated'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => f.replace(/\.js$/, ''));
  }

  async read(resource, params = {}) {
    const generated = this._module('generated', resource);
    const override = this._module('', resource);
    if (!generated && !override) return null;

    const merged = { ...(generated || {}), ...(override || {}) };

    /* A data module may export `select(params)` to vary its own content with
       the request — the attribution screen re-credits revenue per model this
       way, and segmented controls use it to reflect their selection. It is a
       property of this implementation, not of the contract: a query-backed one
       would push the same variation into its query. */
    const { select, ...content } = merged;
    return typeof select === 'function' ? { ...content, ...select(params) } : content;
  }
}

module.exports = () => assertImplements(new StaticRepository(), 'static');
