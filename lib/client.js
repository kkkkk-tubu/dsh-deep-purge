/**
 * dsh-deep-purge —— 客户端半区（浏览器 bundle，手写、无构建步骤）
 *
 * 这个文件由 @deepseek-ai/dsh-client-modules 在页面启动时加载，格式是
 * `window.__ModuleLoader__.load({ id, factory })`。factory 里拿到的 `require`
 * 只能解析两类名字：
 *   1) 平台种子表（react / react/jsx-runtime / react-dom / zod / @tanstack/react-virtual /
 *      @deepseek-ai/dsh-client-store / dsh-client-ui-slots /
 *      dsh-client-ui-primitives / dsh-client-ui-dockkit —— 见 dsh-web-frontend 的
 *      staticModules），
 *   2) 已注册成 bundle 的插件包名。
 * 所以这里只 require("react") 和 "@deepseek-ai/dsh-client-ui-primitives"，
 * 不碰 locale / renderer / connection 这些不在种子表的名字——require 会直接抛
 * `require("…") missed the module table`。
 *
 * 注册的东西：
 *   · sidebar.panellist  -> 左侧导航栏一个条目（图标 + 「会话清理」）
 *   · main               -> 选中该条目时接管主区整页
 *   · sidebar.workspaces.session.menu.item -> 会话右键菜单「彻底删除会话」
 *
 * 真正的界面逻辑全部在 lib/ui.js（宿主路由 /dsh-deep-purge/ui.js 提供），
 * 这里只负责把宿主 DOM 容器交给 window.__DSH_DEEP_PURGE__.mount()。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deep-purge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    /**
     * 平台种子表里的 UI 基础件（dsh-web-frontend 的 staticModules 里有这一项，
     * 所以可以 require）。拿不到就降级成自绘按钮，不影响功能。
     */
    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
    }

    /** 面板 id：导航栏条目与主区页面共用同一个 key，layout 靠它切换。 */
    var PANEL_ID = 'deep-purge'
    /** 导航栏排序：dsh-market=1、dsh-purge=30、skill-explorer=30，我们排在常见条目之后。 */
    var PANEL_ORDER = 45

    /** apply() 里拿到的客户端 ctx，供右键菜单项调用 selectPanel。 */
    var clientCtx = null

    var h = React.createElement

    // ---------------------------------------------------------------- 图标

    /**
     * 导航栏图标：一个垃圾桶。宿主的 PanelRow 只要求这个组件能渲染出 svg，
     * 尺寸由它传进来的 size 决定（宽栏 16、窄栏 18）。
     */
    function PurgeGlyphIcon(props) {
      var size = (props && props.size) || 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'data-dsh-panel-entry': PANEL_ID,
        },
        h('path', { d: 'M3 4.2h10' }),
        h('path', { d: 'M6.2 4.2V2.9h3.6v1.3' }),
        h('path', { d: 'M4.3 4.2l.6 8.3a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.3' }),
        h('path', { d: 'M6.7 6.6v4.2' }),
        h('path', { d: 'M9.3 6.6v4.2' })
      )
    }

    // ---------------------------------------------------------------- 主区页面

    /**
     * 主区整页。真身是 ui.js 里那套原生 DOM，这里只造一个满高的容器，
     * 挂载后把 mount 的 disposer 交还给 React 清理。
     *
     * ui.js 是宿主用 <script> 注入的，加载时机可能晚于本 bundle，
     * 所以要轮询等 window.__DSH_DEEP_PURGE__ 出现。
     */
    function PurgePage() {
      var hostRef = React.useRef(null)

      React.useEffect(function () {
        var cancelled = false
        var dispose = null
        var timer = null

        function attempt() {
          if (cancelled) return
          var api = window.__DSH_DEEP_PURGE__
          if (!api || typeof api.mount !== 'function') {
            timer = window.setTimeout(attempt, 120)
            return
          }
          try {
            dispose = api.mount(hostRef.current)
          } catch (error) {
            console.warn('[dsh-deep-purge] mount failed:', error)
          }
        }

        attempt()

        return function () {
          cancelled = true
          if (timer !== null) window.clearTimeout(timer)
          if (typeof dispose === 'function') {
            try { dispose() } catch (error) { /* 卸载失败不影响切面板 */ }
          }
          var api = window.__DSH_DEEP_PURGE__
          if (api && typeof api.unmount === 'function') {
            try { api.unmount() } catch (error) { /* 同上 */ }
          }
        }
      }, [])

      return h('div', {
        ref: hostRef,
        style: {
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 auto',
          minHeight: 0,
          height: '100%',
          width: '100%',
          overflow: 'hidden',
        },
      })
    }

    // ---------------------------------------------------------------- 右键菜单项

    /** 没拿到宿主 hook 时的占位，保证 hook 调用顺序恒定。 */
    function useNoMenuState() {
      return [false, function () { }]
    }

    function openPurgeForSession(sessionId) {
      var api = window.__DSH_DEEP_PURGE__
      if (api && typeof api.openForSession === 'function') {
        try { api.openForSession(sessionId) } catch (error) { /* 忽略 */ }
      } else {
        window.__DSH_DEEP_PURGE_PENDING__ = String(sessionId || '')
      }
      var layout = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('layout') : null
      if (layout && typeof layout.selectPanel === 'function') {
        try { layout.selectPanel(PANEL_ID) } catch (error) {
          console.warn('[dsh-deep-purge] selectPanel failed:', error)
        }
      }
    }

    /**
     * 会话右键菜单里的一项。宿主的槽位注入 useMenuOpenState，
     * 组件 props 里直接可用；调 setMenuOpen(false) 关掉菜单。
     *
     * 样式优先用平台的 MenuItemButton（种子表里有 dsh-client-ui-primitives，
     * 和宿主的「归档会话」完全同构：图标 + 文字 + danger 色）。
     * 万一拿不到就退化成原生 button，用 ui.js 的 .dsp-menu-item 兜底样式。
     */
    function PurgeSessionMenuItem(props) {
      var sessionId = props && props.sessionId
      var useMenuOpenState =
        props && typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState : useNoMenuState
      var state = useMenuOpenState()
      var setMenuOpen = state && typeof state[1] === 'function' ? state[1] : function () { }

      var onSelect = function () {
        setMenuOpen(false)
        openPurgeForSession(sessionId)
      }

      var MenuItemButton = primitives && primitives.MenuItemButton
      var Icon = primitives && primitives.IconTrashOutlineRegular

      if (typeof MenuItemButton === 'function' || typeof MenuItemButton === 'object') {
        if (MenuItemButton !== null && MenuItemButton !== void 0) {
          return h(
            MenuItemButton,
            {
              danger: true,
              icon: typeof Icon === 'function' ? h(Icon, { size: 14 }) : h(PurgeGlyphIcon, { size: 14 }),
              onSelect: onSelect,
            },
            '彻底删除会话'
          )
        }
      }

      return h(
        'button',
        {
          type: 'button',
          className: 'dsp-menu-item dsp-menu-item-danger',
          title: '彻底删除该会话的全部本地痕迹（会关闭并自动重启 DSH）',
          onClick: onSelect,
        },
        h(PurgeGlyphIcon, { size: 14 }),
        h('span', null, '彻底删除会话')
      )
    }

    // ---------------------------------------------------------------- 注册

    /**
     * 三个槽位都包在 slots.inject 里：宿主没声明对应槽位时回调不执行，
     * 面板就自然缺席，而不是让整个 boot 挂掉。
     */
    function registerSurfaces(ctx) {
      var slots = ctx.slots
      var disposers = []

      disposers.push(
        slots.inject('sidebar.panellist', function () {
          return slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: '会话清理',
            },
            PurgeGlyphIcon
          )
        })
      )

      disposers.push(
        slots.inject('main', function () {
          return slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            PurgePage
          )
        })
      )

      disposers.push(
        slots.inject('sidebar.workspaces.session.menu.item', function () {
          return slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'deep-purge',
              order: 500,
            },
            PurgeSessionMenuItem
          )
        })
      )

      return function () {
        for (var i = 0; i < disposers.length; i += 1) {
          try { disposers[i]() } catch (error) { /* 单个失败不挡其它 */ }
        }
        disposers.length = 0
      }
    }

    /**
     * 需要的宿主服务：
     *   slots  —— 三个槽位注册的唯一入口；
     *   layout —— 右键菜单项点完要 selectPanel，声明它可保证取用时已 provide。
     */
    var inject = ['slots', 'layout']

    function apply(ctx) {
      clientCtx = ctx
      var disposers = []

      try {
        disposers.push(registerSurfaces(ctx))
      } catch (error) {
        console.warn('[dsh-deep-purge] surface registration failed:', error)
      }

      // 菜单项里要 selectPanel；顺手把当前激活面板同步给 ui.js 没必要，
      // 页面卸载由 React effect 负责，这里只做 disposer 托管。
      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            try { disposers[i]() } catch (error) { /* 忽略 */ }
          }
          disposers.length = 0
          clientCtx = null
        }
      }, 'dsh-deep-purge: surfaces')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
//# sourceMappingURL=client.js.map
