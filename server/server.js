// Minimal static server for the LMS frontend.
// Phase 2 will add a /api/certificate endpoint here for server-signed PDFs.
const express = require('express');
const path = require('path');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(compression());

// Health check (used by fly.io)
app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

// Static assets
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // Don't cache the entrypoint or runtime config; we want updates to land immediately
    if (/(course\.html|index\.html|config\.js|auth\.js|course_data\.json)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// SPA-ish fallback to course.html for any unknown route under root
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'course.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`mygenesis-training listening on :${PORT}`);
});
