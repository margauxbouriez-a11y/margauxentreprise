# Margaux Entreprise — plateforme de gestion

Plateforme interne pour piloter l'activité d'une agence d'IA et d'automatisation.
Premier module : **Démarchage** — la liste des entreprises démarchées, leurs contacts, et le suivi
de chaque email envoyé par ton workflow **n8n**.

| Onglet | Ce qu'on y trouve |
| --- | --- |
| Tableau de bord | Nombre d'entreprises, emails envoyés sur 7 jours, taux de réponse, relances à faire, répartition par secteur, dernières activités |
| Démarchage | Entreprises démarchées + contact (nom, poste, email, téléphone), statut (à contacter → contactée → relancée → a répondu → RDV → cliente), historique, notes, export CSV |
| Automatisation n8n | Le nœud n8n à copier-coller, l'adresse et la clé, le workflow complet à télécharger |
| Clients, Projets | Prochains modules |

## Fonctionnement (100 % gratuit)

- **Les pages** (`index.html`, `connexion.html`, `app.js`, `styles.css`) sont publiées par **GitHub Pages**.
- **Les données et les règles** sont dans ton **n8n** :
  - workflow **« Margaux Entreprise — API »** (doit rester **publié**) ;
  - tables **`margaux_prospects`** et **`margaux_activites`**.
- L'adresse de l'API est dans `config.js`.

Le **mot de passe** de l'interface, la **clé** des automatisations, le délai de relance (4 jours) et le nombre
maximum d'emails par entreprise (3) se règlent en haut du nœud **Traiter la demande** de ce workflow.
Ils ne sont jamais écrits dans ce dépôt, qui est public.

## Mise en ligne

**Settings → Pages → Deploy from a branch → `main` / `(root)` → Save.**
La plateforme est alors sur `https://margauxbouriez-a11y.github.io/margauxentreprise/`.

---

## Connecter n8n

Toutes les demandes vont à **une seule adresse** (celle de `config.js`), en `POST`, avec l'en-tête
`X-API-Key: <ta clé>` (ou un champ `"cle"` dans le corps). Le champ **`action`** indique quoi faire.

### Option 1 — Tu as déjà un workflow qui envoie les emails

Ajoute **un seul nœud HTTP Request** juste après ton nœud d'envoi (Gmail, Send Email, Outlook…).
L'onglet *Automatisation n8n* de la plateforme te le donne déjà rempli : copie-le, colle-le dans n8n, relie-le.
Le modèle est [`n8n/noeud-email-envoye.json`](n8n/noeud-email-envoye.json).

```json
{ "action": "n8n_email_envoye", "email": "contact@entreprise.fr", "entreprise": "Nom", "contact_nom": "Prénom Nom", "secteur": "Expertise comptable", "objet": "Premier contact" }
```

Si l'entreprise n'existe pas encore, elle est créée. Son statut passe à *Contactée* (puis *Relancée* au 2e email),
le compteur d'emails augmente et une relance est programmée 4 jours plus tard.

> Dans le champ Body du nœud, remplace `Prospects à contacter` par le nom de **ton** nœud qui contient l'email du destinataire.

### Option 2 — Workflow complet prêt à importer

[`n8n/workflow-demarchage.json`](n8n/workflow-demarchage.json) (ou le bouton *Télécharger le workflow complet* dans la plateforme, déjà rempli) :

- **9 h, du lundi au vendredi** : récupère jusqu'à 20 entreprises « À contacter » → envoie le premier email (Gmail) → enregistre tous les envois en une fois.
- **10 h, du lundi au vendredi** : récupère les relances du jour → envoie la relance → enregistre les envois.
- Après 3 emails sans réponse, l'entreprise n'est plus relancée.

Après l'import : connecte ton compte Gmail dans les deux nœuds d'envoi et remplace `[Ton prénom]`, `[Nom de ton entreprise]`
et `[Ton téléphone]` dans la signature.

### Toutes les actions pour n8n

| `action` | Rôle |
| --- | --- |
| `n8n_email_envoye` | Un email vient de partir : crée l'entreprise si besoin, compte l'envoi, programme la relance. Accepte aussi `"envois": [ … ]` pour en enregistrer plusieurs en une seule fois |
| `n8n_prospects` | Entreprises « À contacter » qui ont un email (options : `limit`, `secteur`, `statut`) |
| `n8n_relances` | Entreprises à relancer aujourd'hui (option : `limit`) |
| `n8n_ajouter` | Ajoute ou met à jour une entreprise ou une liste `"prospects": [ … ]` (dédoublonnage par email) |
| `n8n_reponse` | Une entreprise a répondu : `{ "email": "...", "extrait": "..." }` → statut « A répondu » |

Les champs acceptent les noms français ou anglais (`entreprise`/`company`, `contact_nom`/`name`, `ville`/`city`, `secteur`/`industry`…),
ce qui permet d'envoyer directement des lignes venant de Google Sheets, Apollo, Hunter, etc.

### Exécutions n8n

Chaque demande à l'API compte comme une exécution n8n. La plateforme charge tout l'écran en une seule demande
et ne s'actualise qu'en revenant sur l'onglet ou toutes les 5 minutes ; le workflow de démarchage enregistre
tous les emails d'une matinée en une seule demande.

---

## Secteur conseillé pour démarrer : les cabinets d'expertise comptable

Le modèle d'email vise les cabinets comptables : beaucoup de tâches répétitives (relances de pièces, tri des factures,
ressaisie entre logiciels), un besoin facile à chiffrer en heures gagnées, et des milliers de cabinets de petite taille
où le dirigeant décide seul. Les agences immobilières et les cabinets d'avocats sont de bonnes cibles suivantes ;
le champ *Secteur* permet de comparer les taux de réponse dans le tableau de bord.

## Structure

```
index.html, connexion.html   Pages de la plateforme
app.js, styles.css           Interface
config.js                    Adresse de l'API n8n
n8n/api-code.js              Copie de la logique du nœud « Traiter la demande » (sans mot de passe ni clé)
n8n/*.json                   Nœud et workflow de démarchage à importer
```
