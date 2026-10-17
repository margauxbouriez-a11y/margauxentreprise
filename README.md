# Margaux Entreprise — plateforme de gestion

Plateforme interne pour piloter l'activité d'une agence d'IA et d'automatisation.
Premier module : **Démarchage** — la liste des entreprises démarchées, leurs contacts, et le suivi
de chaque email envoyé par ton workflow **n8n**.

| Onglet | Ce qu'on y trouve |
| --- | --- |
| Tableau de bord | Nombre d'entreprises, emails envoyés sur 7 jours, taux de réponse, relances à faire, répartition par secteur, dernières activités |
| Démarchage | Entreprises démarchées + contact (nom, poste, email, téléphone), statut (à contacter → contactée → relancée → a répondu → RDV → cliente), historique, notes, export CSV |
| Automatisation n8n | Le nœud n8n à copier-coller, ton adresse et ta clé, le workflow complet à télécharger |
| Clients, Projets | Prochains modules |

Aucune dépendance à installer : il suffit de **Node.js 22.9 ou plus récent** (la base SQLite est intégrée à Node).

---

## Lancer en local

```bash
cp .env.example .env      # puis modifie les valeurs
npm start                 # http://localhost:3000
```

## Mettre en ligne (Render)

1. Sur [render.com](https://render.com) : **New → Blueprint**, choisis ce dépôt. Le fichier `render.yaml` configure tout.
2. Renseigne `ADMIN_PASSWORD`. La clé n8n et le secret de session sont générés automatiquement.
3. Ajoute `PUBLIC_URL` avec l'adresse que Render te donne (ex. `https://margauxentreprise.onrender.com`).

> La base de données est un fichier : il faut un **disque persistant** (inclus dans `render.yaml`, offre payante de Render),
> sinon les données sont effacées à chaque redéploiement. Le `Dockerfile` permet aussi d'héberger la plateforme
> ailleurs (Railway, Fly.io, un VPS) en montant un volume sur `/data`.

---

## Connecter n8n

Toutes les requêtes de n8n portent l'en-tête `X-API-Key: <ta clé N8N_API_KEY>`.

### Option 1 — Tu as déjà un workflow qui envoie les emails

Ajoute **un seul nœud HTTP Request** juste après ton nœud d'envoi (Gmail, Send Email, Outlook…).
L'onglet *Automatisation n8n* de la plateforme te donne ce nœud déjà rempli avec ton adresse et ta clé :
copie-le, colle-le dans n8n, relie-le. Le fichier modèle est [`n8n/noeud-email-envoye.json`](n8n/noeud-email-envoye.json).

Il envoie à la plateforme :

```json
POST /api/n8n/email-envoye
{ "email": "contact@entreprise.fr", "entreprise": "Nom", "contact_nom": "Prénom Nom", "secteur": "Expertise comptable", "objet": "Premier contact" }
```

Si l'entreprise n'existe pas encore, elle est créée. Son statut passe à *Contactée* (puis *Relancée* au 2e email),
le compteur d'emails augmente et une relance est programmée `RELANCE_JOURS` jours plus tard.

> Dans le champ Body du nœud, remplace `Prospects à contacter` par le nom de **ton** nœud qui contient l'email du destinataire.

### Option 2 — Workflow complet prêt à importer

[`n8n/workflow-demarchage.json`](n8n/workflow-demarchage.json) (ou le bouton *Télécharger le workflow complet* dans la plateforme, déjà rempli) :

- **9 h, du lundi au vendredi** : récupère jusqu'à 20 entreprises « À contacter » → envoie le premier email (Gmail) → enregistre l'envoi.
- **10 h, du lundi au vendredi** : récupère les relances du jour → envoie la relance → enregistre l'envoi.
- Après `MAX_EMAILS_PAR_PROSPECT` emails sans réponse, l'entreprise n'est plus relancée.

Après l'import : connecte ton compte Gmail dans les deux nœuds d'envoi et remplace `[Ton prénom]`, `[Nom de ton entreprise]`
et `[Ton téléphone]` dans la signature.

### Tous les points d'entrée pour n8n

| Méthode et adresse | Rôle |
| --- | --- |
| `POST /api/n8n/email-envoye` | Un email vient de partir : crée l'entreprise si besoin, compte l'envoi, programme la relance |
| `GET /api/n8n/prospects?limit=20&secteur=…` | Entreprises « À contacter » qui ont un email |
| `GET /api/n8n/relances?limit=20` | Entreprises à relancer aujourd'hui |
| `POST /api/n8n/prospects` | Ajoute ou met à jour une entreprise ou une liste (dédoublonnage par email) |
| `POST /api/n8n/reponse` | Une entreprise a répondu : `{ "email": "...", "extrait": "..." }` → statut « A répondu » |

Les champs acceptent les noms français ou anglais (`entreprise`/`company`, `contact_nom`/`name`, `ville`/`city`, `secteur`/`industry`…),
ce qui permet d'envoyer directement des lignes venant de Google Sheets, Apollo, Hunter, etc.

---

## Secteur conseillé pour démarrer : les cabinets d'expertise comptable

Le modèle d'email vise les cabinets comptables : beaucoup de tâches répétitives (relances de pièces, tri des factures,
ressaisie entre logiciels), un besoin facile à chiffrer en heures gagnées, et des milliers de cabinets de petite taille
où le dirigeant décide seul. Les agences immobilières et les cabinets d'avocats sont de bonnes cibles suivantes ;
le champ *Secteur* permet de comparer les taux de réponse dans le tableau de bord.

## Structure

```
server.js              Routes, connexion, API de l'interface et API n8n
db.js                  Base SQLite (tables prospects et activites)
lib/mini-serveur.js    Petit serveur web sans dépendance
public/                Interface (index.html, app.js, styles.css, connexion.html)
n8n/                   Nœud et workflow n8n à importer
```
