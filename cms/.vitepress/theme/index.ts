import type { Theme } from 'vitepress'
import './style.css'
import DaemonDashboard from './components/DaemonDashboard.vue'

export default {
  Layout: DaemonDashboard,
  enhanceApp({ app }) {
    app.component('DaemonDashboard', DaemonDashboard)
  }
} satisfies Theme
