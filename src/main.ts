import './styles/base.css'
import './styles/components.css'
import { mountShell } from './app/shell'
import { registerRoute, startRouter } from './app/router'
import { dataPage } from './pages/data_page'
import { ppiPage } from './pages/ppi_page'
import { volumePage } from './pages/volume_page'
import { profilePage } from './pages/profile_page'
import { productPage } from './pages/product_page'
import { animationPage } from './pages/animation_page'
import { settingsPage } from './pages/settings_page'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app 挂载点不存在')

registerRoute({ name: 'data', mount: (c) => dataPage(c) })
registerRoute({ name: 'ppi', mount: (c) => ppiPage(c) })
registerRoute({ name: 'volume', mount: (c) => volumePage(c) })
registerRoute({ name: 'profile', mount: (c) => profilePage(c) })
registerRoute({ name: 'product', mount: (c) => productPage(c) })
registerRoute({ name: 'animation', mount: (c) => animationPage(c) })
registerRoute({ name: 'settings', mount: (c) => settingsPage(c) })

const pageContainer = mountShell(app)
startRouter(pageContainer)
