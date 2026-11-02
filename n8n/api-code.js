// Margaux Entreprise — logique de la plateforme (nœud Code du workflow « Margaux Entreprise — API »)
// Reprend les règles de l'ancien serveur : statuts, relances, dédoublonnage par email, statistiques.

const MOT_DE_PASSE = '__MOT_DE_PASSE__';   // connexion à l'interface
const CLE_N8N = '__CLE_N8N__';             // clé des automatisations n8n (en-tête X-API-Key ou champ "cle")
const RELANCE_JOURS = 4;                   // jours avant la relance
const MAX_EMAILS = 3;                      // emails maximum par entreprise

const STATUTS = ['a_contacter', 'contacte', 'relance', 'repondu', 'rdv', 'client', 'perdu'];
const CHAMPS = ['entreprise', 'secteur', 'contact_nom', 'contact_poste', 'email', 'telephone',
  'ville', 'site_web', 'statut', 'notes', 'source', 'prochaine_relance'];
const COLONNES = ['uid', ...CHAMPS, 'emails_envoyes', 'dernier_contact', 'cree_le', 'modifie_le'];

// ---------- Requête ----------
const req = $('Requête').first().json;
let b = req.body;
if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
if (Array.isArray(b)) b = { prospects: b };
b = b || {};
const entetes = req.headers || {};
const action = String(b.action || (req.query || {}).action || '');

// ---------- Données ----------
const vide = (v) => (v === null || v === undefined ? '' : String(v));
const prospects = $('Lire les prospects').all().map((i) => i.json).filter((r) => r && r.uid).map((r) => {
  const p = {};
  for (const c of COLONNES) p[c] = c === 'emails_envoyes' ? Number(r[c]) || 0 : vide(r[c]);
  p._ordre = Number(r.id) || 0;
  return p;
});
const activites = $('Lire les activités').all().map((i) => i.json).filter((r) => r && r.uid)
  .map((r) => ({ uid: r.uid, prospect_uid: vide(r.prospect_uid), type: vide(r.type), detail: vide(r.detail), source: vide(r.source), cree_le: vide(r.cree_le), _ordre: Number(r.id) || 0 }));

const parUid = new Map(prospects.map((p) => [p.uid, p]));
let compteur = 1e12;
const insertsP = new Set(), majP = new Set(), suppP = new Set(), insertsA = [];

const maintenant = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const dansJours = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const aujourdhui = () => new Date().toISOString().slice(0, 10);
const nouvelUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const erreur = (code, message) => Object.assign(new Error(message), { code });

// Champs acceptés en français ou en anglais (n8n, Google Sheets, Apollo…)
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
      if (brut[a] !== undefined && brut[a] !== null && String(brut[a]).trim() !== '') { out[champ] = String(brut[a]).trim(); break; }
    }
  }
  if (out.email) out.email = out.email.toLowerCase();
  if (out.statut && !STATUTS.includes(out.statut)) delete out.statut;
  return out;
}

const parEmail = (email) => email ? prospects.find((p) => p.email && p.email === String(email).toLowerCase().trim()) : undefined;
function trouver(brut) {
  if (brut.id) return parUid.get(String(brut.id));
  return parEmail(normaliser(brut).email);
}

function journal(prospectUid, type, detail, source = 'manuel') {
  const a = { uid: nouvelUid(), prospect_uid: prospectUid || '', type, detail: detail || '', source, cree_le: maintenant(), _ordre: compteur++ };
  activites.push(a);
  insertsA.push(a);
}

function creer(data, source) {
  if (!data.entreprise) {
    if (data.email && data.email.includes('@')) data.entreprise = data.email.split('@')[1].split('.')[0];
    else throw erreur(400, 'Le champ "entreprise" est obligatoire.');
  }
  const p = {};
  for (const c of COLONNES) p[c] = '';
  for (const c of CHAMPS) if (data[c] !== undefined) p[c] = data[c];
  p.uid = nouvelUid();
  p.statut = p.statut || 'a_contacter';
  p.source = data.source || source;
  p.emails_envoyes = 0;
  p.cree_le = p.modifie_le = maintenant();
  p._ordre = compteur++;
  prospects.push(p); parUid.set(p.uid, p); insertsP.add(p.uid);
  journal(p.uid, 'creation', `Prospect ajouté : ${p.entreprise}`, source);
  return p;
}

function modifier(p, data) {
  const cols = Object.keys(data).filter((k) => CHAMPS.includes(k) && k !== 'source');
  if (!cols.length) return p;
  for (const c of cols) p[c] = data[c] === '' ? '' : data[c];
  p.modifie_le = maintenant();
  majP.add(p.uid);
  return p;
}

function enregistrerEmail(p, objet, source) {
  p.statut = p.statut === 'a_contacter' ? 'contacte' : ['contacte', 'relance'].includes(p.statut) ? 'relance' : p.statut;
  p.emails_envoyes = (Number(p.emails_envoyes) || 0) + 1;
  p.dernier_contact = maintenant();
  p.prochaine_relance = dansJours(RELANCE_JOURS);
  p.modifie_le = maintenant();
  majP.add(p.uid);
  journal(p.uid, 'email_envoye', objet ? `Email envoyé : « ${objet} »` : 'Email envoyé', source);
  return p;
}

// Présentation pour l'interface et pour n8n (mêmes noms de champs que l'ancien serveur)
const sortie = (p) => {
  const o = { id: p.uid };
  for (const c of COLONNES) if (c !== 'uid' && c !== 'cree_le' && c !== 'modifie_le') o[c] = p[c] === '' ? null : p[c];
  o.emails_envoyes = Number(p.emails_envoyes) || 0;
  o.created_at = p.cree_le; o.updated_at = p.modifie_le;
  return o;
};
const sortieActivite = (a) => ({
  id: a.uid, prospect_id: a.prospect_uid || null, type: a.type, detail: a.detail, source: a.source, created_at: a.cree_le,
  entreprise: a.prospect_uid && parUid.has(a.prospect_uid) && !suppP.has(a.prospect_uid) ? parUid.get(a.prospect_uid).entreprise : null,
});
const parDate = (x, y) => (y.cree_le || '').localeCompare(x.cree_le || '') || y._ordre - x._ordre;
const relancable = (p) => ['contacte', 'relance'].includes(p.statut) && p.prochaine_relance && p.prochaine_relance <= aujourdhui() && p.emails_envoyes < MAX_EMAILS;
const vivants = () => prospects.filter((p) => !suppP.has(p.uid));

function statistiques() {
  const liste = vivants();
  const parStatut = Object.fromEntries(STATUTS.map((s) => [s, 0]));
  for (const p of liste) parStatut[p.statut] = (parStatut[p.statut] || 0) + 1;
  const total = liste.length;
  const emails = liste.reduce((s, p) => s + (Number(p.emails_envoyes) || 0), 0);
  const il7j = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const il13j = new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10);
  const envois = activites.filter((a) => a.type === 'email_envoye');
  const emails7j = envois.filter((a) => a.cree_le >= il7j).length;
  const contactes = total - parStatut.a_contacter;
  const reponses = parStatut.repondu + parStatut.rdv + parStatut.client;
  const relancesDues = liste.filter(relancable).length;
  const secteurs = {};
  for (const p of liste) {
    const s = p.secteur || 'Non renseigné';
    secteurs[s] ||= { secteur: s, n: 0, reponses: 0 };
    secteurs[s].n++;
    if (['repondu', 'rdv', 'client'].includes(p.statut)) secteurs[s].reponses++;
  }
  const jours = {};
  for (const a of envois) { const j = a.cree_le.slice(0, 10); if (j >= il13j) jours[j] = (jours[j] || 0) + 1; }
  return {
    total, parStatut, emails, emails7j, relancesDues,
    parSecteur: Object.values(secteurs).sort((x, y) => y.n - x.n),
    parJour: Object.entries(jours).map(([jour, n]) => ({ jour, n })),
    tauxReponse: contactes ? Math.round((reponses / contactes) * 100) : 0,
  };
}

// ---------- Réponse + écritures à faire ----------
function fin(code, reponse) {
  const ops = [];
  for (const uid of insertsP) if (!suppP.has(uid)) ops.push({ op: 'prospect_ajouter', ...ligneP(parUid.get(uid)) });
  for (const uid of majP) if (!insertsP.has(uid) && !suppP.has(uid)) ops.push({ op: 'prospect_modifier', ...ligneP(parUid.get(uid)) });
  for (const uid of suppP) if (!insertsP.has(uid)) ops.push({ op: 'prospect_supprimer', uid }, { op: 'historique_supprimer', prospect_uid: uid });
  for (const a of insertsA) if (!a.prospect_uid || !suppP.has(a.prospect_uid)) {
    ops.push({ op: 'activite_ajouter', uid: a.uid, prospect_uid: a.prospect_uid, type: a.type, detail: a.detail, source: a.source, cree_le: a.cree_le });
  }
  if (!ops.length) ops.push({ op: 'rien' });
  ops[0]._code = code;
  ops[0]._reponse = JSON.stringify(reponse);
  return ops.map((o) => ({ json: o }));
}
function ligneP(p) {
  const l = {};
  for (const c of COLONNES) l[c] = c === 'emails_envoyes' ? Number(p[c]) || 0 : vide(p[c]);
  return l;
}
const remiseAZero = () => { insertsP.clear(); majP.clear(); suppP.clear(); insertsA.length = 0; };

// ---------- Actions ----------
try {
  const cleRecue = String(entetes['x-api-key'] || b.cle || (req.query || {}).api_key || '');
  const viaN8n = action.startsWith('n8n_');

  if (viaN8n) {
    if (cleRecue !== CLE_N8N) throw erreur(401, "Clé API absente ou invalide. Ajoute l'en-tête X-API-Key dans ton nœud n8n.");
  } else if (String(b.mdp || '') !== MOT_DE_PASSE) {
    throw erreur(401, 'Mot de passe incorrect.');
  }

  const p = b.id ? parUid.get(String(b.id)) : undefined;
  const exigerP = () => { if (!p || suppP.has(p.uid)) throw erreur(404, 'Prospect introuvable.'); };

  switch (action) {
    // ----- Interface -----
    case 'connexion':
      return fin(200, { ok: true });

    case 'etat': {
      const liste = vivants().sort((x, y) => (y.modifie_le || '').localeCompare(x.modifie_le || '') || y._ordre - x._ordre);
      const dernierN8n = activites.filter((a) => a.source === 'n8n').map((a) => a.cree_le).sort().pop() || null;
      return fin(200, {
        prospects: liste.map(sortie),
        stats: statistiques(),
        secteurs: [...new Set(liste.map((x) => x.secteur).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'fr')),
        activites: activites.slice().sort(parDate).slice(0, Number(b.limit) || 12).map(sortieActivite),
        config: { cle: CLE_N8N, relanceJours: RELANCE_JOURS, maxEmails: MAX_EMAILS, dernierN8n },
      });
    }

    case 'creer': {
      const data = normaliser(b.data || {});
      if (data.email && parEmail(data.email)) throw erreur(409, 'Un prospect avec cet email existe déjà.');
      return fin(201, sortie(creer(data, 'manuel')));
    }

    case 'modifier': {
      exigerP();
      const brut = b.data || {};
      const data = normaliser(brut);
      for (const k of CHAMPS) if (brut[k] === '') data[k] = '';
      if (data.email && data.email !== p.email && parEmail(data.email)) throw erreur(409, 'Un autre prospect utilise déjà cet email.');
      const ancien = p.statut;
      modifier(p, data);
      if (data.statut && data.statut !== ancien) journal(p.uid, 'statut', `Statut : ${ancien} → ${data.statut}`);
      return fin(200, sortie(p));
    }

    case 'supprimer':
      exigerP();
      suppP.add(p.uid);
      journal(null, 'suppression', `Prospect supprimé : ${p.entreprise}`);
      return fin(200, { ok: true });

    case 'email':
      exigerP();
      return fin(200, sortie(enregistrerEmail(p, b.objet, 'manuel')));

    case 'note': {
      exigerP();
      const texte = String(b.texte || '').trim();
      if (!texte) throw erreur(400, 'La note est vide.');
      journal(p.uid, 'note', texte);
      p.modifie_le = maintenant(); majP.add(p.uid);
      return fin(200, { ok: true });
    }

    case 'historique':
      exigerP();
      return fin(200, activites.filter((a) => a.prospect_uid === p.uid).sort(parDate).map(sortieActivite));

    // ----- Automatisations n8n -----
    case 'n8n_prospects': {
      const statut = b.statut || 'a_contacter';
      const limite = Math.min(Number(b.limit) || 20, 200);
      return fin(200, vivants()
        .filter((x) => x.statut === statut && x.email && (!b.secteur || x.secteur === b.secteur))
        .sort((x, y) => (x.cree_le || '').localeCompare(y.cree_le || '') || x._ordre - y._ordre)
        .slice(0, limite).map(sortie));
    }

    case 'n8n_relances':
      return fin(200, vivants().filter((x) => relancable(x) && x.email)
        .sort((x, y) => x.prochaine_relance.localeCompare(y.prochaine_relance))
        .slice(0, Math.min(Number(b.limit) || 20, 200)).map(sortie));

    case 'n8n_ajouter': {
      const liste = Array.isArray(b.prospects) ? b.prospects : [b];
      const res = { crees: 0, mis_a_jour: 0, erreurs: [] };
      for (const brut of liste) {
        try {
          const data = normaliser(brut);
          const existant = parEmail(data.email);
          if (existant) { modifier(existant, data); res.mis_a_jour++; }
          else { creer(data, 'n8n'); res.crees++; }
        } catch (e) { res.erreurs.push({ entree: brut, erreur: e.message }); }
      }
      return fin(res.erreurs.length && !res.crees && !res.mis_a_jour ? 400 : 200, res);
    }

    case 'n8n_email_envoye': {
      // Un envoi, ou plusieurs d'un coup avec "envois": [...] (une seule exécution n8n)
      const envois = Array.isArray(b.envois) ? b.envois : [b];
      const faits = [];
      for (const e of envois) {
        let x = trouver(e);
        if (!x) x = creer(normaliser(e), 'n8n');
        faits.push(sortie(enregistrerEmail(x, e.objet || e.subject, 'n8n')));
      }
      return fin(200, Array.isArray(b.envois) ? { ok: true, enregistres: faits.length } : faits[0]);
    }

    case 'n8n_reponse': {
      const x = trouver(b);
      if (!x) throw erreur(404, 'Aucun prospect ne correspond à cet email.');
      const statut = STATUTS.includes(b.statut) ? b.statut : 'repondu';
      modifier(x, { statut, prochaine_relance: '' });
      const extrait = b.extrait || b.snippet || b.message;
      journal(x.uid, 'reponse', extrait ? `Réponse reçue : ${String(extrait).slice(0, 500)}` : 'Réponse reçue', 'n8n');
      return fin(200, sortie(x));
    }

    default:
      throw erreur(400, `Action inconnue : « ${action} ».`);
  }
} catch (e) {
  remiseAZero();
  return fin(e.code || 500, { erreur: e.message });
}
