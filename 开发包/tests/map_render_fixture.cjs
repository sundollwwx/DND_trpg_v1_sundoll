// DOM boundary for the production map renderer. Cover geometry and rendering
// remain real so a missing dependency cannot turn map tests into empty stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { APP_ROOT } = require('./project_paths.cjs');
const { readClientSource } = require('./client_sources.cjs');
const rules = require(path.join(APP_ROOT, 'shared/rules.js'));

class MapElement {
  constructor(tagName = 'div', style = {}) {
    this.tagName = tagName;
    this.style = style;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  set innerHTML(value) {
    assert.match(value, /^<path\b/, 'the overlay fixture only supports the production SVG path');
    this.children = [new MapElement('path')];
  }
  get firstChild() { return this.children[0] || null; }
  append(child) { this.children.push(child); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelector(selector) {
    assert.equal(selector, '.map-cover-overlay');
    return this.children.find(child => child.classList.contains('map-cover-overlay')) || null;
  }
}

function createMapDom(style = {}) {
  return {
    world: new MapElement('div', style),
    document: { createElementNS: (namespace, tagName) => {
      assert.equal(namespace, 'http://www.w3.org/2000/svg');
      return new MapElement(tagName);
    } },
  };
}

function installPlayerMapRenderer(context) {
  const source = readClientSource('主控台/玩家.html');
  const start = source.indexOf("  let lastMapPaintKey = '';");
  const end = source.indexOf('  function normalizedMapPreloadUrl(', start);
  assert.ok(start >= 0 && end > start, 'production map renderer and its local dependencies exist');
  context.SundollRules = rules;
  context.SundollClientRuntime = require(path.join(APP_ROOT,'主控台/shared/client-runtime.js'));
  vm.runInContext(fs.readFileSync(path.join(APP_ROOT, 'shared/token-size.js'), 'utf8'), context);
  vm.runInContext('const mapVariantFailures = new Set();\n' + source.slice(start, end), context);
  return context;
}

module.exports = { MapElement, createMapDom, installPlayerMapRenderer, rules };
