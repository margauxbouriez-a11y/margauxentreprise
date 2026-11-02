// Interface de la plateforme
const STATUTS = {
  a_contacter: 'À contacter',
  contacte: 'Contactée',
  relance: 'Relancée',
  repondu: 'A répondu',
  rdv: 'RDV pris',
  client: 'Cliente',
  perdu: 'Pas intéressée',
};
const ICONES = { creation: '＋', email_envoye: '✉', reponse: '↩', statut: '⇄', note: '✎', suppression: '–' };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const echap = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const etat = { prospects: [], filtreStatut: '', secteur: '', q: '', courant: null, config: null, donnees: null };

// ---------- Connexion à l'API n8n ----------
const lireMdp = () => { try { return localStorage.getItem('plateforme-mdp') || sessionStorage.getItem('plateforme-mdp'); } catch { return null; } };
const oublierMdp = () => { try { localStorage.removeItem('plateforme-mdp'); sessionStorage.removeItem('plateforme-mdp'); } catch {} };
const MDP = lireMdp();
if (!MDP) location.replace('connexion.html' + location.hash);

async function appel(action, donnees = {}) {
  let r;
  try {
    r = await fetch(window.PLATEFORME.api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, mdp: MDP, ...donnees }),
    });
  } catch {
    throw new Error('Le serveur ne répond pas. Vérifie ta connexion internet, puis réessaie.');
  }
  if (r.status === 401) { oublierMdp(); location.href = 'connexion.html'; throw new Error('Mot de passe à ressaisir'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.erreur || `Erreur ${r.status}`);
  return data;
}

// Toutes les données de l'écran en une seule demande (une exécution n8n)
let chargement = null;
function chargerEtat() {
  chargement ||= appel('etat', { limit: 12 })
    .then((d) => { etat.donnees = d; etat.config = d.config; majTemoinN8n(); return d; })
    .finally(() => { chargement = null; });
  return chargement;
}

function toast(msg, erreur = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('erreur', erreur);
  t.classList.add('visible');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('visible'), 2600);
}

function dateCourte(s) {
  if (!s) return '';
  const d = new Date(s.length <= 10 ? s + 'T00:00:00' : s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
function ilYa(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return dateCourte(s);
}
const aujourdhui = () => new Date().toISOString().slice(0, 10);
const badge = (s) => `<span class="badge" style="--c:var(--s-${s})">${STATUTS[s] || s}</span>`;

// ---------- Navigation ----------
function afficher(onglet) {
  $$('[data-vue]').forEach((v) => (v.hidden = v.dataset.vue !== onglet));
  $$('[data-onglet]').forEach((b) => {
    if (b.dataset.onglet === onglet) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  history.replaceState(null, '', '#' + onglet);
  const erreur = (e) => toast(e.message, true);
  if (onglet === 'tableau') chargerTableau().catch(erreur);
  if (onglet === 'demarchage') chargerProspects().catch(erreur);
  if (onglet === 'n8n') chargerN8n().catch(erreur);
}
$$('[data-onglet]').forEach((b) => b.addEventListener('click', () => afficher(b.dataset.onglet)));

// ---------- Tableau de bord ----------
async function chargerTableau() {
  const { stats: s, activites } = await chargerEtat();
  $('#k-total').textContent = s.total;
  $('#k-emails7').textContent = s.emails7j;
  $('#k-taux').textContent = s.tauxReponse + ' %';
  $('#k-relances').textContent = s.relancesDues;
  $('#kpi-relances').classList.toggle('alerte', s.relancesDues > 0);
  $('#nb-prospects').textContent = s.total;

  const parJour = Object.fromEntries(s.parJour.map((r) => [r.jour, r.n]));
  const jours = [...Array(14)].map((_, i) => new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10));
  const max = Math.max(1, ...jours.map((j) => parJour[j] || 0));
  $('#histo').innerHTML = jours.map((j) => {
    const n = parJour[j] || 0;
    return `<div><i style="height:${(n / max) * 100}%" data-n="${n}" title="${n} email(s) le ${dateCourte(j)}"></i><span>${new Date(j + 'T00:00:00').getDate()}</span></div>`;
  }).join('');

  const maxS = Math.max(1, ...s.parSecteur.map((r) => r.n));
  $('#secteurs').innerHTML = s.parSecteur.length ? s.parSecteur.slice(0, 6).map((r) => `
    <div class="secteur-ligne"><span>${echap(r.secteur)}</span><span class="sous">${r.n} · ${r.reponses} réponse${r.reponses > 1 ? 's' : ''}</span>
    <div class="jauge"><i style="width:${(r.n / maxS) * 100}%"></i></div></div>`).join('')
    : '<p class="sous">Les secteurs apparaîtront dès que tu auras des prospects.</p>';

  $('#flux').innerHTML = activites.length ? activites.map(ligneActivite).join('')
    : '<li><span class="ico">＋</span><span>Aucune activité pour l\'instant. Ajoute une entreprise ou lance ton workflow n8n.</span><span></span></li>';
}

function ligneActivite(a) {
  const qui = a.entreprise ? `<b>${echap(a.entreprise)}</b> — ` : '';
  const src = a.source === 'n8n' ? '<span class="src-n8n">n8n</span>' : '';
  return `<li><span class="ico">${ICONES[a.type] || '•'}</span><span>${qui}${echap(a.detail)}${src}</span><time>${ilYa(a.created_at)}</time></li>`;
}

// ---------- Démarchage ----------
async function chargerProspects(donnees) {
  const { prospects, stats, secteurs } = donnees || await chargerEtat();
  etat.prospects = prospects;
  $('#nb-prospects').textContent = stats.total;

  $('#pipeline').innerHTML = Object.entries(STATUTS).map(([k, v]) => `
    <button class="etape" style="--c:var(--s-${k})" data-statut="${k}" aria-pressed="${etat.filtreStatut === k}">
      <b>${stats.parStatut[k] || 0}</b><span>${v}</span></button>`).join('');
  $$('#pipeline .etape').forEach((b) => b.addEventListener('click', () => {
    etat.filtreStatut = etat.filtreStatut === b.dataset.statut ? '' : b.dataset.statut;
    chargerProspects(etat.donnees);
  }));

  const sel = $('#filtre-secteur');
  sel.innerHTML = '<option value="">Tous les secteurs</option>' + secteurs.map((s) => `<option ${s === etat.secteur ? 'selected' : ''}>${echap(s)}</option>`).join('');
  $('#liste-secteurs').innerHTML = [...new Set([...SECTEURS_SUGGERES, ...secteurs])].map((s) => `<option value="${echap(s)}">`).join('');
  rendreLignes();
}

const SECTEURS_SUGGERES = ['Expertise comptable', 'Agences immobilières', 'Cabinets d\'avocats', 'BTP et artisans', 'Cliniques et cabinets médicaux', 'E-commerce', 'Hôtellerie et restauration', 'Transport et logistique'];

function rendreLignes() {
  const q = etat.q.toLowerCase();
  const liste = etat.prospects.filter((p) =>
    (!etat.filtreStatut || p.statut === etat.filtreStatut) &&
    (!etat.secteur || p.secteur === etat.secteur) &&
    (!q || [p.entreprise, p.contact_nom, p.email, p.ville].some((v) => (v || '').toLowerCase().includes(q))));

  const vide = $('#vide');
  if (!etat.prospects.length) {
    vide.hidden = false;
    vide.innerHTML = `<h3>Aucune entreprise démarchée pour l'instant</h3>
      <p>Ajoute ta première entreprise à la main, ou connecte ton workflow n8n : chaque email envoyé l'ajoutera ici.</p>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <button class="btn principal" onclick="ouvrir()">Ajouter une entreprise</button>
        <button class="btn" onclick="afficher('n8n')">Connecter n8n</button></div>`;
  } else if (!liste.length) {
    vide.hidden = false;
    vide.innerHTML = `<h3>Aucun résultat</h3><p>Aucune entreprise ne correspond à ces filtres.</p><button class="btn" id="raz">Effacer les filtres</button>`;
    $('#raz').onclick = () => { etat.filtreStatut = ''; etat.secteur = ''; etat.q = ''; $('#recherche').value = ''; chargerProspects(etat.donnees); };
  } else vide.hidden = true;

  const auj = aujourdhui();
  $('#lignes').innerHTML = liste.map((p) => {
    const enRetard = p.prochaine_relance && p.prochaine_relance <= auj && ['contacte', 'relance'].includes(p.statut);
    return `<tr data-id="${echap(p.id)}" tabindex="0">
      <td><div class="nom-ent">${echap(p.entreprise)}${p.source === 'n8n' ? '<span class="src-n8n">n8n</span>' : ''}</div>
        <div class="sous">${echap([p.secteur, p.ville].filter(Boolean).join(', '))}</div></td>
      <td><div>${echap(p.contact_nom || '—')}${p.contact_poste ? `<span class="sous">, ${echap(p.contact_poste)}</span>` : ''}</div>
        <div class="sous">${echap(p.email || p.telephone || '')}</div></td>
      <td>${badge(p.statut)}</td>
      <td class="col-option">${p.emails_envoyes}<div class="sous">${p.dernier_contact ? 'dernier ' + dateCourte(p.dernier_contact) : ''}</div></td>
      <td class="col-option ${enRetard ? 'retard' : ''}">${p.prochaine_relance && ['contacte', 'relance'].includes(p.statut) ? (enRetard ? 'À faire · ' : '') + dateCourte(p.prochaine_relance) : '<span class="sous">—</span>'}</td>
    </tr>`;
  }).join('');
  $$('#lignes tr').forEach((tr) => {
    const ouvrirLigne = () => ouvrir(etat.prospects.find((p) => p.id === tr.dataset.id));
    tr.addEventListener('click', ouvrirLigne);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') ouvrirLigne(); });
  });
}

$('#recherche').addEventListener('input', (e) => { etat.q = e.target.value; rendreLignes(); });
$('#filtre-secteur').addEventListener('change', (e) => { etat.secteur = e.target.value; rendreLignes(); });
$('#ajouter').addEventListener('click', () => ouvrir());

// ---------- Panneau prospect ----------
$('#select-statut').innerHTML = Object.entries(STATUTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');

function ouvrir(p = null) {
  etat.courant = p;
  const f = $('#form-prospect');
  f.reset();
  if (p) for (const el of f.elements) if (el.name) el.value = p[el.name] ?? '';
  $('#panneau-titre').textContent = p ? p.entreprise : 'Nouvelle entreprise';
  $('#panneau-sous').innerHTML = p ? `${badge(p.statut)} <span style="margin-left:6px">${p.emails_envoyes} email${p.emails_envoyes > 1 ? 's' : ''} envoyé${p.emails_envoyes > 1 ? 's' : ''}</span>` : '';
  $('#supprimer').hidden = !p;
  $('#zone-suivi').hidden = !p;
  $('#zone-historique').hidden = !p;
  $('#enregistrer').textContent = p ? 'Enregistrer' : 'Ajouter l\'entreprise';
  $('#panneau').classList.add('ouvert');
  $('#panneau').setAttribute('aria-hidden', 'false');
  $('#voile').classList.add('ouvert');
  if (p) chargerHistorique(p.id);
  setTimeout(() => f.elements.entreprise.focus(), 50);
}
function fermer() {
  $('#panneau').classList.remove('ouvert');
  $('#panneau').setAttribute('aria-hidden', 'true');
  $('#voile').classList.remove('ouvert');
  etat.courant = null;
}
$('#fermer').onclick = fermer;
$('#annuler').onclick = fermer;
$('#voile').onclick = fermer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermer(); });

async function chargerHistorique(id) {
  const a = await appel('historique', { id });
  $('#historique').innerHTML = a.map((x) => ligneActivite({ ...x, entreprise: null })).join('') || '<li><span></span><span class="sous">Rien pour l\'instant.</span><span></span></li>';
}

async function rafraichirCourant(id) {
  await chargerProspects().catch((e) => toast(e.message, true));
  const p = etat.prospects.find((x) => x.id === id);
  if (p) ouvrir(p);
}

$('#enregistrer').onclick = async () => {
  const f = $('#form-prospect');
  if (!f.reportValidity()) return;
  const data = Object.fromEntries(new FormData(f));
  const bouton = $('#enregistrer');
  bouton.disabled = true;
  try {
    if (etat.courant) {
      await appel('modifier', { id: etat.courant.id, data });
      toast('Modifications enregistrées');
    } else {
      await appel('creer', { data });
      toast('Entreprise ajoutée');
    }
    fermer();
    chargerProspects().catch(() => {});
  } catch (e) { toast(e.message, true); }
  finally { bouton.disabled = false; }
};

$('#supprimer').onclick = async () => {
  if (!etat.courant || !confirm(`Supprimer ${etat.courant.entreprise} et son historique ?`)) return;
  try {
    await appel('supprimer', { id: etat.courant.id });
    toast('Entreprise supprimée');
    fermer();
    chargerProspects();
  } catch (e) { toast(e.message, true); }
};

$('#noter-email').onclick = async () => {
  const id = etat.courant.id;
  try {
    await appel('email', { id });
    toast('Email noté, relance programmée');
    rafraichirCourant(id);
  } catch (e) { toast(e.message, true); }
};
$$('[data-statut-rapide]').forEach((b) => b.addEventListener('click', async () => {
  const id = etat.courant.id;
  try {
    await appel('modifier', { id, data: { statut: b.dataset.statutRapide } });
    toast(`Statut : ${STATUTS[b.dataset.statutRapide]}`);
    rafraichirCourant(id);
  } catch (e) { toast(e.message, true); }
}));
$('#form-note').addEventListener('submit', async (e) => {
  e.preventDefault();
  const texte = $('#note-texte').value.trim();
  if (!texte) return;
  try {
    await appel('note', { id: etat.courant.id, texte });
    $('#note-texte').value = '';
    chargerHistorique(etat.courant.id);
  } catch (err) { toast(err.message, true); }
});

// ---------- n8n ----------
function majTemoinN8n() {
  const c = etat.config;
  if (!c) return;
  const ok = !!c.dernierN8n;
  $('#pastille-n8n').classList.toggle('ok', ok);
  $('#texte-n8n').textContent = ok ? `n8n : dernier envoi ${ilYa(c.dernierN8n)}` : 'n8n : aucun envoi reçu';
}

// Modèles du dossier n8n/, complétés avec l'adresse et la clé
async function modeleN8n(fichier) {
  const r = await fetch(`n8n/${fichier}`, { cache: 'no-cache' });
  if (!r.ok) throw new Error('Modèle n8n introuvable.');
  return (await r.text())
    .replaceAll('https://TA-PLATEFORME.exemple.com/webhook/margaux-entreprise', window.PLATEFORME.api)
    .replaceAll('COLLE_TA_CLE_N8N_ICI', etat.config.cle);
}

async function chargerN8n() {
  if (!etat.config) await chargerEtat();
  const c = etat.config;
  $('#url-envoi').textContent = window.PLATEFORME.api;
  $('#cle-api').textContent = c.cle;
  $('#noeud-json').textContent = await modeleN8n('noeud-email-envoye.json').catch((e) => e.message);
  const points = [
    ['n8n_email_envoye', 'Après chaque email : ajoute l\'entreprise si besoin, compte l\'envoi, programme la relance. Accepte aussi une liste « envois » pour tout enregistrer en une fois.'],
    ['n8n_prospects', 'Liste des entreprises « À contacter » pour que n8n leur écrive (options : limit, secteur).'],
    ['n8n_relances', 'Entreprises à relancer aujourd\'hui (option : limit).'],
    ['n8n_ajouter', 'Ajoute ou met à jour une ou plusieurs entreprises (champ « prospects », ex. depuis Google Sheets).'],
    ['n8n_reponse', 'Quand une entreprise répond : passe son statut à « A répondu ».'],
  ];
  $('#points').innerHTML = points.map(([a, b]) => `<tr><td>action : ${a}</td><td>${b}</td></tr>`).join('');
}

function telecharger(nom, contenu, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([contenu], { type }));
  a.download = nom;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#telecharger-workflow').onclick = async () => {
  try {
    if (!etat.config) await chargerEtat();
    telecharger('workflow-demarchage.json', await modeleN8n('workflow-demarchage.json'), 'application/json');
  } catch (e) { toast(e.message, true); }
};

$('#exporter').onclick = () => {
  const cols = ['entreprise', 'secteur', 'contact_nom', 'contact_poste', 'email', 'telephone', 'ville', 'site_web',
    'statut', 'emails_envoyes', 'dernier_contact', 'prochaine_relance', 'notes'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lignes = etat.prospects.slice().sort((a, b) => a.entreprise.localeCompare(b.entreprise, 'fr'));
  const csv = [cols.join(';'), ...lignes.map((r) => cols.map((c) => esc(r[c])).join(';'))].join('\n');
  telecharger('prospects.csv', '\ufeff' + csv, 'text/csv;charset=utf-8');
};

$$('[data-copier]').forEach((b) => b.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#' + b.dataset.copier).textContent);
    toast('Copié');
  } catch { toast('Copie impossible : sélectionne le texte à la main', true); }
}));

$('#deconnexion').onclick = () => { oublierMdp(); location.href = 'connexion.html'; };

// ---------- Démarrage ----------
// Chaque actualisation compte comme une exécution n8n : on recharge quand tu reviens sur l'onglet,
// et toutes les 5 minutes s'il reste ouvert devant toi.
function actualiser() {
  if (document.hidden || $('#panneau').classList.contains('ouvert')) return;
  const vue = $$('[data-vue]').find((v) => !v.hidden)?.dataset.vue;
  const silence = () => {};
  if (vue === 'tableau') chargerTableau().catch(silence);
  else if (vue === 'demarchage') chargerProspects().catch(silence);
  else chargerEtat().catch(silence);
}
if (MDP) {
  const depart = ['tableau', 'demarchage', 'n8n'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'demarchage';
  afficher(depart);
  let derniere = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - derniere > 60000) { derniere = Date.now(); actualiser(); }
  });
  setInterval(() => { derniere = Date.now(); actualiser(); }, 5 * 60000);
}
