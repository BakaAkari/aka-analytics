import { Context } from '@koishijs/client'
import {} from 'koishi-plugin-aka-analytics/src'
import Charts from './charts'
import Home from './home.vue'
import Analytics from './pages/analytics.vue'
import './icons'

import 'virtual:uno.css'

export default (ctx: Context) => {
  // ctx.app.provide('ecTheme', 'koishi-dark')
  ctx.plugin(Charts)

  ctx.slot({
    type: 'home',
    component: Home,
    order: 0,
  })

  ctx.page({
    path: '/analytics',
    component: Analytics,
  })
}
