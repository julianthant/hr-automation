# HR Dashboard

Real-time split-panel dashboard for monitoring HR workflow progress.

## Running

Start the SSE backend + Vite dev server:

```bash
node --import tsx/esm --env-file=.env src/cli.ts dashboard
```

Then open **http://localhost:5173**

### Dev server only (no SSE backend)

```bash
node node_modules/vite/bin/vite.js --config vite.dashboard.config.ts
```

### Production build

```bash
node node_modules/vite/bin/vite.js build --config vite.dashboard.config.ts
```

Outputs a single-file HTML to `dist/dashboard/index.html`.
