import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('the client bundle registers the settings section and its dictionaries', () => {
  let registration
  const styles = []
  const document = {
    baseURI: 'http://127.0.0.1:3080/',
    querySelector() {
      return null
    },
    createElement() {
      const element = { dataset: {}, textContent: '' }
      styles.push(element)
      return element
    },
    head: {
      appendChild(element) {
        assert.ok(element.textContent.includes('.rtk-root'))
      },
    },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          registration = spec
        },
      },
    },
    document,
    Intl,
    URL,
    Symbol,
    Object,
    console,
  }
  vm.runInNewContext(source, sandbox)

  assert.equal(registration.id, '@rtk-ai/dsh-rtk-filter')

  const react = {
    Fragment: Symbol('fragment'),
    createElement() {
      return { type: 'element' }
    },
    useState() {
      return [undefined, () => {}]
    },
    useEffect() {},
  }
  const plugin = registration.factory((request) => {
    assert.equal(request, 'react')
    return react
  })

  assert.equal(styles.length, 1)
  assert.equal(styles[0].dataset.plugin, '@rtk-ai/dsh-rtk-filter')
  assert.equal(plugin.inject.join(','), 'slots,locale')
  assert.equal(plugin.NS, 'settings.rtkFilter')

  const dictionaries = []
  const slots = []
  const ctx = {
    effect(fn) {
      return fn()
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.section')
        return callback()
      },
      register(spec, component) {
        slots.push({ spec, component })
        return () => {}
      },
    },
  }

  plugin.apply(ctx)

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'settings.rtkFilter')
  assert.equal(dictionaries[0].dicts.zh.nav, 'RTK 命令过滤')
  assert.equal(dictionaries[0].dicts.en.nav, 'RTK command filtering')

  assert.equal(slots.length, 1)
  assert.equal(slots[0].spec.name, 'settings.section')
  assert.equal(slots[0].spec.id, 'rtk-filter')
  assert.equal(slots[0].spec.order, 30)
  assert.equal(slots[0].spec.locale, 'settings.rtkFilter')
  assert.equal(slots[0].spec.label(), 'nav')
  assert.equal(typeof slots[0].component, 'function')
})
