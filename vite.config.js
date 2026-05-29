import { defineConfig, loadEnv } from 'vite'

// Dev-only shim: the plain Vite dev server doesn't run Vercel serverless
// functions, so POST /api/anthropic 404s locally (it only exists on Vercel /
// `vercel dev`). This middleware mounts that same handler during `npm run dev`
// by reusing api/anthropic.js, adapting Node's req/res to the Express-like
// (req, res) signature the handler expects. Production is unaffected — Vercel
// serves the real function.
function devAnthropicApi() {
  return {
    name: 'dev-anthropic-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/anthropic', async (req, res) => {
        // Buffer and parse the JSON body into req.body (Vercel does this for us).
        let raw = ''
        for await (const chunk of req) raw += chunk
        try { req.body = raw ? JSON.parse(raw) : {} } catch { req.body = {} }

        // Adapt Node's ServerResponse to the handler's res.status().json() API.
        const resShim = {
          statusCode: 200,
          status(code) { this.statusCode = code; return this },
          json(obj) {
            res.statusCode = this.statusCode
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(obj))
          },
        }

        try {
          const { default: handler } = await import('./api/anthropic.js')
          await handler(req, resShim)
        } catch (e) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'Dev shim error: ' + (e.message || e) }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Load ALL env vars (incl. un-prefixed, server-only ones) so the dev shim's
  // handler can read ANTHROPIC_KEY etc. Vite still only exposes VITE_* to the
  // browser bundle, so the key never reaches client code.
  const env = loadEnv(mode, process.cwd(), '')
  for (const k of ['ANTHROPIC_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_KEY']) {
    if (env[k] && !process.env[k]) process.env[k] = env[k]
  }

  return {
    root: '.',
    build: {
      outDir: 'dist',
    },
    plugins: [devAnthropicApi()],
  }
})
