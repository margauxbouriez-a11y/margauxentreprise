// Plateforme de gestion — serveur principal
const express = require('./lib/mini-serveur'); // aucune dépendance externe
const crypto = require('node:crypto');
const path = require('node:path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changemoi';
const API_KEY = process.env.N8N_API_KEY || 'cle-n8n-a-changer';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const RELANCE_JOURS = Number(process.env.RELANCE_JOURS || 4);
const MAX_EMAILS = Number(process.env.MAX_EMAILS_PAR_PROSPECT || 3);

if (ADMIN_PASSWORD === 'changemoi' || API_KEY === 'cle-n8n-a-changer') {
  if (process.env.NODE_ENV === 'production') {
    console.error('ADMIN_PASSWORD et N8N_API_KEY doivent être définis en production.');
    process.exit(1);
  }
  console.warn('⚠️  ADMIN_PASSWORD ou N8N_API_KEY n\'est pas défini : utilise des valeurs à toi avant de mettre en ligne.');
}

const STATUTS = ['a_contacter', 'contacte', 'relance', 'repondu', 'rdv', 'client', 'perdu'];
const CHAMPS = ['entreprise', 'secteur', 'contact_nom', 'contact_poste', 'email', 'telephone',
  'ville', 'site_web', 'statut', 'notes', 'source', 'prochaine_relance'];

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

// ---------- Utilitaires ----------
const maintenant = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const dansJours = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// Accepte des noms de champs en français ou en anglais (n8n, Google Sheets, Apollo, etc.)
const ALIAS = {
  entreprise: ['entreprise', 'company', 'societe', 'société', 'nom_entreprise', 'organisation', 'organization', 'company_name'],
  secteur: ['secteur', 'industry', 'sector', 'activite', 'activité'],
  contact_nom: ['contact_nom', 'contact', 'nom', 'name', 'full_name', 'nom_contact', 'first_name'],
  contact_poste: ['contact_poste', 'poste', 'title', 'job_title', 'fonction'],
  email: ['email', 'mail', 'e-mail', 'to', 'toEmail', 'destinataire'],
  telephone: ['telephone', 'téléphone', 'phone', 'tel', 'mobile'],
  ville: ['ville', 'city', 'localisation', 'location'],
  site_web: ['site_web', 'site', 'website', 'url', 'domain'],
  statut: ['statut', 'status'],
  notes: ['notes', 'note', 'commentaire'],
  source: ['source'],
  prochaine_relance: ['prochaine_relance', 'next_follow_up'],
};
function normaliser(brut = {}) {
  const out = {};
  for (const [champ, alias] of Object.entries(ALIAS)) {
    for (const a of alias) {
      if (brut[a] !== undefined && brut[a] !== null && String(brut[a]).trim() !== '') {
        out[champ] = String(brut[a]).trim();
        break;
      }
    }
  }
  if (out.email) out.email = out.email.toLowerCase();
  if (out.statut && !STATUTS.includes(out.statut)) delete out.statut;
  return out;
}

function journal(prospectId, type, detail, source = 'manuel') {
  db.prepare('INSERT INTO activites (prospect_id, type, detail, source) VALUES (?, ?, ?, ?)')
    .run(prospectId ?? null, type, detail ?? null, source);
}

const getProspect = (id) => db.prepare('SELECT * FROM prospects WHERE id = ?').get(id);
const getParEmail = (email) => email ? db.prepare('SELECT * FROM prospects WHERE email = ?').get(String(email).toLowerCase().trim()) : undefined;

function trouver(body) {
  if (body.id) return getProspect(Number(body.id));
  const n = normaliser(body);
  return getParEmail(n.email);
}

function creer(data, source) {
  if (!data.entreprise) {
    // Sans nom d'entreprise, on en déduit un depuis le domaine de l'email
    if (data.email && data.email.includes('@')) data.entreprise = data.email.split('@')[1].split('.')[0];
    else throw Object.assign(new Error('Le champ "entreprise" est obligatoire.'), { status: 400 });
  }
  data.source = data.source || source;
  const cols = Object.keys(data).filter((k) => CHAMPS.includes(k));
  const r = db.prepare(`INSERT INTO prospects (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => data[c]));
  journal(r.lastInsertRowid, 'creation', `Prospect ajouté : ${data.entreprise}`, source);
  return getProspect(r.lastInsertRowid);
}

function modifier(id, data) {
  const cols = Object.keys(data).filter((k) => CHAMPS.includes(k) && k !== 'source');
  if (!cols.length) return getProspect(id);
  db.prepare(`UPDATE prospects SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => (data[c] === '' ? null : data[c])), maintenant(), id);
  return getProspect(id);
}

function enregistrerEmail(p, objet, source) {
  const nouveauStatut = ['a_contacter'].includes(p.statut) ? 'contacte'
    : ['contacte', 'relance'].includes(p.statut) ? 'relance' : p.statut;
  db.prepare(`UPDATE prospects SET emails_envoyes = emails_envoyes + 1, dernier_contact = ?,
      prochaine_relance = ?, statut = ?, updated_at = ? WHERE id = ?`)
    .run(maintenant(), dansJours(RELANCE_JOURS), nouveauStatut, maintenant(), p.id);
  journal(p.id, 'email_envoye', objet ? `Email envoyé : « ${objet} »` : 'Email envoyé', source);
  return getProspect(p.id);
}

// ---------- Authentification de l'interface ----------
function signer(valeur) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(valeur).digest('hex');
}
function lireCookie(req, nom) {
  const c = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(nom + '='));
  return c ? decodeURIComponent(c.slice(nom.length + 1)) : null;
}
function estConnecte(req) {
  const jeton = lireCookie(req, 'session');
  if (!jeton) return false;
  const [expire, sig] = jeton.split('.');
  if (!expire || !sig || Number(expire) < Date.now()) return false;
  const attendu = signer(expire);
  return sig.length === attendu.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(attendu));
}
function exigerSession(req, res, next) {
  if (estConnecte(req)) return next();
  res.status(401).json({ erreur: 'Session expirée, reconnecte-toi.' });
}
function exigerCleApi(req, res, next) {
  const cle = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.api_key;
  if (cle && cle.length === API_KEY.length && crypto.timingSafeEqual(Buffer.from(cle), Buffer.from(API_KEY))) return next();
  res.status(401).json({ erreur: 'Clé API absente ou invalide. Ajoute l\'en-tête X-API-Key dans ton nœud n8n.' });
}

app.post('/connexion', (req, res) => {
  const mdp = String(req.body?.mot_de_passe || '');
  const ok = mdp.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(mdp), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ erreur: 'Mot de passe incorrect.' });
  const expire = String(Date.now() + 30 * 864e5);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${expire}.${signer(expire)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
  res.json({ ok: true });
});
app.post('/deconnexion', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- API de l'interface ----------
const api = express.Router();
api.use(exigerSession);

api.get('/prospects', (req, res) => {
  const { statut, secteur, q } = req.query;
  const where = [];
  const params = [];
  if (statut) { where.push('statut = ?'); params.push(statut); }
  if (secteur) { where.push('secteur = ?'); params.push(secteur); }
  if (q) {
    where.push('(entreprise LIKE ? OR contact_nom LIKE ? OR email LIKE ? OR ville LIKE ?)');
    params.push(...Array(4).fill(`%${q}%`));
  }
  const sql = `SELECT * FROM prospects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

api.post('/prospects', (req, res, next) => {
  try {
    const data = normaliser(req.body);
    if (data.email && getParEmail(data.email)) return res.status(409).json({ erreur: 'Un prospect avec cet email existe déjà.' });
    res.status(201).json(creer(data, 'manuel'));
  } catch (e) { next(e); }
});

api.put('/prospects/:id', (req, res, next) => {
  try {
    const p = getProspect(Number(req.params.id));
    if (!p) return res.status(404).json({ erreur: 'Prospect introuvable.' });
    const data = normaliser(req.body);
    // Permet de vider un champ depuis le formulaire
    for (const k of CHAMPS) if (req.body[k] === '') data[k] = '';
    if (data.email && data.email !== p.email && getParEmail(data.email)) {
      return res.status(409).json({ erreur: 'Un autre prospect utilise déjà cet email.' });
    }
    const maj = modifier(p.id, data);
    if (data.statut && data.statut !== p.statut) journal(p.id, 'statut', `Statut : ${p.statut} → ${data.statut}`);
    res.json(maj);
  } catch (e) { next(e); }
});

api.delete('/prospects/:id', (req, res) => {
  const p = getProspect(Number(req.params.id));
  if (!p) return res.status(404).json({ erreur: 'Prospect introuvable.' });
  db.prepare('DELETE FROM prospects WHERE id = ?').run(p.id);
  journal(null, 'suppression', `Prospect supprimé : ${p.entreprise}`);
  res.json({ ok: true });
});

api.post('/prospects/:id/email', (req, res) => {
  const p = getProspect(Number(req.params.id));
  if (!p) return res.status(404).json({ erreur: 'Prospect introuvable.' });
  res.json(enregistrerEmail(p, req.body?.objet, 'manuel'));
});

api.post('/prospects/:id/note', (req, res) => {
  const p = getProspect(Number(req.params.id));
  if (!p) return res.status(404).json({ erreur: 'Prospect introuvable.' });
  const texte = String(req.body?.texte || '').trim();
  if (!texte) return res.status(400).json({ erreur: 'La note est vide.' });
  journal(p.id, 'note', texte);
  db.prepare('UPDATE prospects SET updated_at = ? WHERE id = ?').run(maintenant(), p.id);
  res.json({ ok: true });
});

api.get('/prospects/:id/activites', (req, res) => {
  res.json(db.prepare('SELECT * FROM activites WHERE prospect_id = ? ORDER BY id DESC').all(Number(req.params.id)));
});

api.get('/activites', (req, res) => {
  res.json(db.prepare(`SELECT a.*, p.entreprise FROM activites a LEFT JOIN prospects p ON p.id = a.prospect_id
    ORDER BY a.id DESC LIMIT ?`).all(Number(req.query.limit || 30)));
});

api.get('/stats', (req, res) => {
  const parStatut = Object.fromEntries(STATUTS.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT statut, COUNT(*) n FROM prospects GROUP BY statut').all()) parStatut[r.statut] = r.n;
  const total = Object.values(parStatut).reduce((a, b) => a + b, 0);
  const emails = db.prepare('SELECT COALESCE(SUM(emails_envoyes),0) n FROM prospects').get().n;
  const emails7j = db.prepare(`SELECT COUNT(*) n FROM activites WHERE type = 'email_envoye' AND created_at >= datetime('now','-7 days')`).get().n;
  const contactes = total - parStatut.a_contacter;
  const reponses = parStatut.repondu + parStatut.rdv + parStatut.client;
  const relancesDues = db.prepare(`SELECT COUNT(*) n FROM prospects WHERE statut IN ('contacte','relance')
    AND prochaine_relance <= date('now') AND emails_envoyes < ?`).get(MAX_EMAILS).n;
  const parSecteur = db.prepare(`SELECT COALESCE(secteur,'Non renseigné') secteur, COUNT(*) n,
    SUM(CASE WHEN statut IN ('repondu','rdv','client') THEN 1 ELSE 0 END) reponses
    FROM prospects GROUP BY 1 ORDER BY n DESC`).all();
  const parJour = db.prepare(`SELECT date(created_at) jour, COUNT(*) n FROM activites
    WHERE type = 'email_envoye' AND created_at >= date('now','-13 days') GROUP BY 1`).all();
  res.json({
    total, parStatut, emails, emails7j, relancesDues, parSecteur, parJour,
    tauxReponse: contactes ? Math.round((reponses / contactes) * 100) : 0,
  });
});

api.get('/secteurs', (req, res) => {
  res.json(db.prepare('SELECT DISTINCT secteur FROM prospects WHERE secteur IS NOT NULL ORDER BY secteur').all().map((r) => r.secteur));
});

api.get('/config', (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const dernier = db.prepare(`SELECT MAX(created_at) d FROM activites WHERE source = 'n8n'`).get().d;
  res.json({ base, cle: API_KEY, cleParDefaut: API_KEY === 'cle-n8n-a-changer', relanceJours: RELANCE_JOURS, maxEmails: MAX_EMAILS, dernierN8n: dernier });
});

api.get('/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM prospects ORDER BY entreprise').all();
  const cols = ['entreprise', 'secteur', 'contact_nom', 'contact_poste', 'email', 'telephone', 'ville', 'site_web',
    'statut', 'emails_envoyes', 'dernier_contact', 'prochaine_relance', 'notes'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(';'), ...rows.map((r) => cols.map((c) => esc(r[c])).join(';'))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="prospects.csv"');
  res.send('﻿' + csv);
});


// ---------- API pour n8n (protégée par clé) ----------
const n8n = express.Router();
n8n.use(exigerCleApi);

// n8n lit la liste des entreprises à démarcher
n8n.get('/prospects', (req, res) => {
  const statut = req.query.statut || 'a_contacter';
  const limit = Math.min(Number(req.query.limit || 20), 200);
  const params = [statut];
  let sql = 'SELECT * FROM prospects WHERE statut = ? AND email IS NOT NULL';
  if (req.query.secteur) { sql += ' AND secteur = ?'; params.push(req.query.secteur); }
  sql += ' ORDER BY created_at ASC LIMIT ?';
  params.push(limit);
  res.json(db.prepare(sql).all(...params));
});

// n8n lit les prospects à relancer aujourd'hui
n8n.get('/relances', (req, res) => {
  res.json(db.prepare(`SELECT * FROM prospects WHERE statut IN ('contacte','relance') AND email IS NOT NULL
    AND prochaine_relance <= date('now') AND emails_envoyes < ? ORDER BY prochaine_relance LIMIT ?`)
    .all(MAX_EMAILS, Math.min(Number(req.query.limit || 20), 200)));
});

// n8n ajoute ou met à jour des prospects (un objet ou une liste)
n8n.post('/prospects', (req, res) => {
  const liste = Array.isArray(req.body) ? req.body : [req.body];
  const resultat = { crees: 0, mis_a_jour: 0, erreurs: [] };
  for (const brut of liste) {
    try {
      const data = normaliser(brut);
      const existant = getParEmail(data.email);
      if (existant) { modifier(existant.id, data); resultat.mis_a_jour++; }
      else { creer(data, 'n8n'); resultat.crees++; }
    } catch (e) { resultat.erreurs.push({ entree: brut, erreur: e.message }); }
  }
  res.status(resultat.erreurs.length && !resultat.crees && !resultat.mis_a_jour ? 400 : 200).json(resultat);
});

// n8n signale qu'un email vient d'être envoyé (crée le prospect s'il n'existe pas)
n8n.post('/email-envoye', (req, res, next) => {
  try {
    let p = trouver(req.body);
    if (!p) p = creer(normaliser(req.body), 'n8n');
    const objet = req.body.objet || req.body.subject;
    res.json(enregistrerEmail(p, objet, 'n8n'));
  } catch (e) { next(e); }
});

// n8n signale qu'une entreprise a répondu
n8n.post('/reponse', (req, res) => {
  const p = trouver(req.body);
  if (!p) return res.status(404).json({ erreur: 'Aucun prospect ne correspond à cet email.' });
  const statut = STATUTS.includes(req.body.statut) ? req.body.statut : 'repondu';
  modifier(p.id, { statut, prochaine_relance: '' });
  const extrait = req.body.extrait || req.body.snippet || req.body.message;
  journal(p.id, 'reponse', extrait ? `Réponse reçue : ${String(extrait).slice(0, 500)}` : 'Réponse reçue', 'n8n');
  res.json(getProspect(p.id));
});

// n8n doit être monté avant /api (qui exige une session)
app.use('/api/n8n', n8n);
app.use('/api', api);

app.get('/sante', (req, res) => res.json({ ok: true }));

// Fichiers n8n prêts à importer, avec ton adresse et ta clé déjà remplies
app.get('/n8n/:fichier', (req, res) => {
  if (!estConnecte(req)) return res.redirect('/connexion');
  const fichiers = ['noeud-email-envoye.json', 'workflow-demarchage.json'];
  if (!fichiers.includes(req.params.fichier)) return res.status(404).end();
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const contenu = require('node:fs').readFileSync(path.join(__dirname, 'n8n', req.params.fichier), 'utf8')
    .replaceAll('https://TA-PLATEFORME.exemple.com', base)
    .replaceAll('COLLE_TA_CLE_N8N_ICI', API_KEY);
  res.type('application/json').send(contenu);
});

// ---------- Pages ----------
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/connexion', (req, res) => res.sendFile(path.join(__dirname, 'public', 'connexion.html')));
app.get('/', (req, res) => {
  if (!estConnecte(req)) return res.redirect('/connexion');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
  const status = err.status || (String(err.message).includes('UNIQUE') ? 409 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ erreur: status === 409 ? 'Cet email existe déjà.' : err.message });
});

app.listen(PORT, () => console.log(`Plateforme en ligne sur http://localhost:${PORT}`));
