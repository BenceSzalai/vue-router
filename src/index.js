var Recognizer = require('route-recognizer')
var Route = require('./route')
var installed = false
var Vue

/**
 * Router constructor
 *
 * @param {Object} [options]
 *                 - {String} root
 *                 - {Boolean} hashbang  (default: true)
 *                 - {Boolean} pushstate (default: false)
 */

function Router (options) {
  options = options || {}

  // Vue instances
  this.app = null
  this._children = []

  // route recognizer
  this._recognizer = new Recognizer()
  this._redirectRecognizer = new Recognizer()

  // state
  this._started = false
  this._currentRoute = { path: '' }

  // feature detection
  this._hasPushState = typeof history !== 'undefined' && history.pushState

  // global handler/hooks
  this._notFoundHandler = options.notFound || null
  this._beforeEachHook = options.beforeEach || null
  this._afterEachHook = options.afterEach || null

  // other options
  this._hashbang = options.hashbang !== false
  this._history = !!(this._hasPushState && options.history)
  this._saveScrollPosition = !!options.saveScrollPosition

  // resolve root path
  var root = options && options.root
  if (root) {
    // make sure there's the starting slash
    if (root.charAt(0) !== '/') {
      root = '/' + root
    }
    // remove trailing slash
    this._root = root.replace(/\/$/, '')
  } else {
    this._root = null
  }
}

/**
 * Installation interface.
 * Install the necessary directives.
 */

Router.install = function (ExternalVue) {
  if (installed) {
    warn('vue-router has already been installed.')
    return
  }
  Vue = ExternalVue
  installed = true
  require('./view')(Vue)
  require('./link')(Vue)
  require('./override')(Vue, Router)
}

//
// Public API
//

var p = Router.prototype

/**
 * Register a map of top-level paths.
 */

p.map = function (map) {
  for (var route in map) {
    this.on(route, map[route])
  }
}

/**
 * Register a single root-level path
 *
 * @param {String} rootPath
 * @param {Object} config
 *                 - {String} component
 *                 - {Object} [subRoutes]
 *                 - {Boolean} [forceRefresh]
 *                 - {Function} [before]
 *                 - {Function} [after]
 */

p.on = function (rootPath, config) {
  if (rootPath === '*') {
    this.notFound(config)
  } else {
    this._addRoute(rootPath, config, [])
  }
}

/**
 * Set the notFound route config.
 *
 * @param {Object} config
 */

p.notFound = function (config) {
  this._notFoundHandler = [{ handler: config }]
}

/**
 * Set redirects.
 *
 * @param {Object} map
 */

p.redirect = function (map) {
  for (var path in map) {
    this._addRedirect(path, map[path])
  }
}

/**
 * Set global before hook.
 *
 * @param {Function} fn
 */

p.beforeEach = function (fn) {
  this._beforeEachHook = fn
}

/**
 * Set global after hook.
 *
 * @param {Function} fn
 */

p.afterEach = function (fn) {
  this._afterEachHook = fn  
}

/**
 * Navigate to a given path.
 * The path is assumed to be already decoded, and will
 * be resolved against root (if provided)
 *
 * @param {String} path
 * @param {Object} [options]
 */

p.go = function (path, options) {
  var replace = options && options.replace
  if (this._hasPushState) {
    var url
    if (this._history) {
      // make path relative to root if specified
      path = this._root
        ? this._root + '/' + path.replace(/^\//, '')
        : path
      url = path
    } else {
      // format path into proper hash and create full url
      path = path.replace(/^#!?/, '')
      url = location.pathname + location.search
      if (path) {
        url += '#' + (this._hashbang ? '!' + path : path)
      }
    }
    if (replace) {
      history.replaceState({}, '', url)
    } else {
      // record scroll position
      var pos = {
        x: window.pageXOffset,
        y: window.pageYOffset
      }
      history.replaceState({ pos: pos }, '', location.href)
      // actually push new state
      history.pushState({}, '', url)
    }
    this._match(path)
  } else {
    // just set hash
    path = path.replace(/^#!?/, '')
    setHash(this._hashbang ? '!' + path : path, replace)
  }
}

/**
 * Short hand for replacing current path
 *
 * @param {String} path
 */

p.replace = function (path) {
  this.go(path, {
    replace: true
  })
}

/**
 * Start the router.
 *
 * @param {VueConstructor} App
 * @param {String|Element} container
 */

p.start = function (App, container) {
  if (!installed) {
    throw new Error(
      'Please install vue-router with Vue.use() before ' +
      'starting the router.'
    )
  }
  if (this._started) {
    warn('vue-router has already been started.')
    return
  }
  this._started = true
  if (!this.app) {
    if (!App || !container) {
      throw new Error(
        'Must start vue-router with a component and a ' +
        'root container.'
      )
    }
    this._appContainer = container
    this._appConstructor = typeof App === 'function'
      ? App
      : Vue.extend(App)
  }
  if (this._hasPushState) {
    this._initHistoryMode()
  } else {
    this._initHashMode()
  }
}

/**
 * Stop listening to route changes.
 */

p.stop = function () {
  var event = this._history
    ? 'popstate'
    : 'hashchange'
  window.removeEventListener(event, this._onRouteChange)
  this._started = false
}

//
// Private Methods
//

/**
 * Initialize HTML5 history mode.
 */

p._initHistoryMode = function () {
  var self = this
  this._onRouteChange = function (e) {
    var url = location.pathname + location.search
    if (self._history) {
      url = decodeURI(url)
      // respet base tag
      var base = document.querySelector('base')
      if (base) {
        url = url.replace(base.getAttribute('href'), '')
      }
      self._match(url)
    } else {
      // delegate hashbang formatting to router.go
      self.replace(decodeURI(location.hash))
    }
    // restore scroll position if saved
    var pos = e && e.state && e.state.pos
    if (pos && self._saveScrollPosition) {
      Vue.nextTick(function () {
        window.scrollTo(pos.x, pos.y)
      })
    }
  }
  window.addEventListener('popstate', this._onRouteChange)
  this._onRouteChange()
}

/**
 * Initialize hash mode.
 */

p._initHashMode = function () {
  var self = this
  this._onRouteChange = function () {
    // format hashbang
    var hash = location.hash
    if (self._hashbang && hash && hash.charAt(1) !== '!') {
      setHash('!' + hash.slice(1), true)
      return
    }
    if (!self._hashbang && hash && hash.charAt(1) === '!') {
      setHash(hash.slice(2), true)
      return
    }
    hash = hash.replace(/^#!?/, '')
    var url = hash + location.search
    url = decodeURI(url)
    self._match(url)
  }
  window.addEventListener('hashchange', this._onRouteChange)
  this._onRouteChange()
}

/**
 * Add a route containing a list of segments to the internal
 * route recognizer. Will be called recursively to add all
 * possible sub-routes.
 *
 * @param {String} path
 * @param {Object} handler
 * @param {Array} segments
 */

p._addRoute = function (path, handler, segments) {
  
  // guard raw components
  guardComponent(handler)
  if (handler.namedViews) {
    for (var name in handler.namedViews) {
      guardComponent(handler.namedViews[name])
    }
  }

  segments.push({
    path: path,
    handler: handler
  })
  this._recognizer.add(segments)
  if (handler.subRoutes) {
    for (var subPath in handler.subRoutes) {
      // recursively walk all sub routes
      this._addRoute(
        subPath,
        handler.subRoutes[subPath],
        // pass a copy in recursion to avoid mutating
        // across branches
        segments.slice()
      )
    }
  }
}

/**
 * Add a redirect record.
 *
 * @param {String} path
 * @param {String} redirectPath
 */

p._addRedirect = function (path, redirectPath) {
  var router = this
  this._redirectRecognizer.add([{
    path: path,
    handler: function (match) {
      var realPath = redirectPath
      if (match.isDynamic) {
        for (var key in match.params) {
          var regex = new RegExp(':' + key + '(\\/|$)')
          var value = match.params[key]
          realPath = realPath.replace(regex, value)
        } 
      }
      router.replace(realPath)
    }
  }])
}

/**
 * Check if a path matches any redirect records.
 *
 * @param {String} path
 * @return {Boolean} - if true, will skip normal match.
 */

p._checkRedirect = function (path) {
  var matched = this._redirectRecognizer.recognize(path)
  if (matched) {
    matched[0].handler(matched[0])
    return true
  }
}

/**
 * Match a URL path and set the route context on vm,
 * triggering view updates.
 *
 * @param {String} path
 */

p._match = function (path) {

  if (this._checkRedirect(path)) {
    return
  }

  var currentRoute = this._currentRoute
  if (this.app && path === currentRoute.path) {
    return
  }

  // normalize against root
  if (
    this._history &&
    this._root &&
    path.indexOf(this._root) === 0
  ) {
    path = path.slice(this._root.length)
  }

  // construct route context
  var route = new Route(path, this)

  // check gloal before hook
  if (this._beforeEachHook) {
    var res = this._beforeEachHook.call(null, currentRoute, route)
    if (res === false) {
      this.replace(currentRoute.path)
      return
    }
  }

  if (!this.app) {
    // initial render
    this.app = new this._appConstructor({
      el: this._appContainer,
      data: {
        route: route
      }
    })
  } else {
    // route change
    this.app.route = route
    this._children.forEach(function (child) {
      child.route = route
    })
  }

  // check global after hook
  if (this._afterEachHook) {
    this._afterEachHook.call(null, currentRoute, route)
  }

  this._currentRoute = route
}

//
// Helpers
//

/**
 * Set current hash
 *
 * @param {String} hash
 * @param {Boolean} replace
 */

function setHash (hash, replace) {
  if (replace) {
    var urlLength = location.href.length - location.hash.length
    var fullURL = location.href.slice(0, urlLength) + '#' + hash
    location.replace(fullURL)
  } else {
    location.hash = hash
  }
}

/**
 * Warning (check console for IE9)
 *
 * @param {String} msg
 */

function warn (msg) {
  if (typeof console !== 'undefined') {
    console.warn(msg)
  }
}

/**
 * Allow directly passing components to a route
 * definition.
 *
 * @param {Object} handler
 */

function guardComponent (handler) {
  if (!Vue) {
    warn('Please install vue-router before defining routes.')
    return
  }
  var comp = handler.component
  var type = typeof comp
  if (type !== 'string') {
    if (type !== 'function') {
      comp = Vue.extend(comp)
    }
    if (!comp.cid) {
      Vue.warn && Vue.warn(
        'invalid router component: ' + comp
      )
      handler.component = null
      return
    }
    // generate a unique id for the anonymous component
    // and register it globally
    var id = 'router-view-' + comp.cid
    if (!Vue.component(id)) {
      Vue.component(id, comp)
    }
    // overwrite the definition so we don't do this again
    handler.component = id
  }
}

// auto install
if (window.Vue) {
  Router.install(window.Vue)
}

module.exports = Router