// Mini-serveur web sans dépendance (API compatible avec le sous-ensemble d'Express utilisé par server.js)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function compiler(motif, exact) {
  const cles = [];
  const re = motif.replace(/\/+$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, k) => { cles.push(k); return '([^/]+)'; });
  return { regexp: new RegExp('^' + re + (exact ? '/?$' : '(?=/|$)')), cles };
}

function Routeur() {
  const pile = [];
  const routeur = (req, res, next) => gerer(req, res, next);
  routeur.use = (a, b) => {
    const [motif, fn] = typeof a === 'string' ? [a, b] : ['', a];
    pile.push({ ...compiler(motif, false), fn, prefixe: motif.replace(/\/+$/, '') });
    return routeur;
  };
  for (const m of ['get', 'post', 'put', 'delete']) {
    routeur[m] = (motif, ...fns) => {
      for (const fn of fns) pile.push({ ...compiler(motif, true), fn, methode: m.toUpperCase() });
      return routeur;
    };
  }
  function gerer(req, res, fin) {
    let i = 0;
    const base = req.chemin;
    const suivant = (err) => {
      req.chemin = base;
      const couche = pile[i++];
      if (!couche) return fin(err);
      if (couche.methode && couche.methode !== req.method && !(couche.methode === 'GET' && req.method === 'HEAD')) return suivant(err);
      const m = couche.regexp.exec(base);
      if (!m) return suivant(err);
      couche.cles.forEach((k, j) => (req.params[k] = decodeURIComponent(m[j + 1])));
      const estErreur = couche.fn.length === 4;
      if (err && !estErreur) return suivant(err);
      if (!err && estErreur) return suivant();
      if (!couche.methode && couche.prefixe) req.chemin = base.slice(couche.prefixe.length) || '/';
      try {
        const r = err ? couche.fn(err, req, res, suivant) : couche.fn(req, res, suivant);
        if (r && typeof r.catch === 'function') r.catch(suivant);
      } catch (e) { suivant(e); }
    };
    suivant();
  }
  return routeur;
}

function enrichir(req, res, confiance) {
  const url = new URL(req.url, 'http://x');
  req.chemin = decodeURIComponent(url.pathname);
  req.query = Object.fromEntries(url.searchParams);
  req.params = {};
  req.get = (n) => req.headers[n.toLowerCase()];
  const fwd = confiance && req.headers['x-forwarded-proto'];
  req.protocol = fwd ? String(fwd).split(',')[0].trim() : (req.socket.encrypted ? 'https' : 'http');
  req.secure = req.protocol === 'https';

  res.status = (c) => { res.statusCode = c; return res; };
  res.type = (t) => { res.setHeader('Content-Type', TYPES['.' + t] || t); return res; };
  res.send = (corps) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(corps);
    return res;
  };
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  res.redirect = (loc) => { res.statusCode = 302; res.setHeader('Location', loc); res.end(); };
  res.sendFile = (f) => {
    fs.readFile(f, (err, data) => {
      if (err) return res.status(404).end('Introuvable');
      res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
      res.end(data);
    });
  };
}

function lireCorps(req, limite = 2 * 1024 * 1024) {
  return new Promise((ok, ko) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return ok({});
    const morceaux = [];
    let taille = 0;
    req.on('data', (c) => {
      taille += c.length;
      if (taille > limite) { ko(Object.assign(new Error('Requête trop volumineuse.'), { status: 413 })); req.destroy(); }
      else morceaux.push(c);
    });
    req.on('end', () => {
      const brut = Buffer.concat(morceaux).toString('utf8');
      if (!brut) return ok({});
      try { ok(JSON.parse(brut)); }
      catch { ko(Object.assign(new Error('Le corps de la requête doit être du JSON valide.'), { status: 400 })); }
    });
    req.on('error', ko);
  });
}

function creerApp() {
  const routeur = Routeur();
  const reglages = {};
  const app = routeur;
  app.set = (k, v) => { reglages[k] = v; };
  app.listen = (port, cb) => {
    const serveur = http.createServer(async (req, res) => {
      enrichir(req, res, reglages['trust proxy']);
      const fin = (err) => {
        if (err) { res.statusCode = err.status || 500; return res.json({ erreur: err.message }); }
        res.statusCode = 404;
        res.json({ erreur: 'Page introuvable.' });
      };
      try { req.body = await lireCorps(req); }
      catch (e) { return fin(e); }
      routeur(req, res, fin);
    });
    return serveur.listen(port, cb);
  };
  return app;
}

creerApp.Router = Routeur;
creerApp.json = () => (req, res, next) => next(); // le corps JSON est déjà lu par le serveur
creerApp.static = (dossier) => (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const f = path.join(dossier, path.normalize(req.chemin).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(dossier)) return next();
  fs.stat(f, (err, st) => (err || !st.isFile() ? next() : res.sendFile(f)));
};

module.exports = creerApp;
