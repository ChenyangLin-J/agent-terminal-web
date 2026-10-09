import path from 'node:path';
import { readFile } from 'node:fs/promises';

export function registerGeneratedEntryRoutes(app, directory) {
  app.get(['/', '/index.html'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(directory, 'index.html'), error => {
      if (!error) return;
      if (error.code === 'ENOENT' || error.status === 404) return res.status(503).type('text/plain').send('Session application build is unavailable.');
      next(error);
    });
  });
  for (const extension of ['js', 'css']) {
    app.get(`/generated/session-app.${extension}`, async (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      try {
        const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
        const target = manifest[extension];
        if (typeof target !== 'string' || !new RegExp(`^/generated/[a-z0-9._-]+-[A-Z0-9]{8}\\.${extension}$`, 'i').test(target)) throw new Error('Invalid asset manifest.');
        res.redirect(307, target);
      } catch {
        res.status(503).type('text/plain').send('Session application build is unavailable.');
      }
    });
  }
}

export function setGeneratedAssetCacheHeaders(res, file) {
  const hashed = /-[A-Z0-9]{8}\.(?:js|css|woff2?|ttf|otf)$/i.test(path.basename(file));
  const entry = ['manifest.json', 'index.html'].includes(path.basename(file));
  res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : entry ? 'no-cache' : 'public, max-age=0');
}
