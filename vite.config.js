import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import aboutUsHandler from './api/about-us.js'
import impactScoreHandler from './api/impact-score.js'
import photoIdentifierHandler from './api/photo-identifier.js'
import riskMapHandler from './api/risk-map.js'
import scoreboardHandler from './api/scoreboard.js'
import hunterProfileHandler from './api/hunter-profile.js'
import wildlifeIntelligenceHandler from './api/wildlife-intelligence.js'

const localApiRoutes = {
  'about-us': { handler: aboutUsHandler, action: 'stats' },
  'impact-score': { handler: impactScoreHandler, action: 'data' },
  'photo-identifier': { handler: photoIdentifierHandler, action: 'identify' },
  'risk-map': { handler: riskMapHandler, action: 'data' },
  scoreboard: { handler: scoreboardHandler, action: 'data' },
  'hunter-profile': { handler: hunterProfileHandler, action: 'profile' },
  'wildlife-intelligence': { handler: wildlifeIntelligenceHandler, action: 'feed' },
}

const getLocalApiRouteName = (url) => url.pathname.replace(/^\/api\/?/, '').replace(/^\/+|\/+$/g, '')

// Adapt the five Vercel API files into Vite middleware for local development.
const createApiMiddleware = () => async (req, res) => {
  // Give Vite requests the same API shape as deployment.
  const url = new URL(req.url || '/', 'http://localhost')
  const query = Object.fromEntries(url.searchParams.entries())
  const routeName = getLocalApiRouteName(url)
  const route = localApiRoutes[routeName]
  const reqLike = Object.assign(req, { query })

  const resLike = {
    status(code) {
      res.statusCode = code
      return this
    },
    json(payload) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(payload))
    },
  }

  try {
    if (!route) {
      resLike.status(404).json({ error: `Unknown API route: ${routeName || '/'}` })
      return
    }

    reqLike.featureAction = reqLike.query.action || route.action
    await route.handler(reqLike, resLike)
  } catch (error) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: error?.message || 'Unexpected error' }))
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
    {
      name: 'local-api-routes',
      configureServer(server) {
        // Register local API routes for development.
        server.middlewares.use('/api', createApiMiddleware())
      },
    },
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
})
