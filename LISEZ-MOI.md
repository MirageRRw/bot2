# Bot Docktease — mise en route

## 1. Côté Discord (portail développeur)
1. Application › **Bot** : copie le **token** (garde-le secret) et active **Server Members Intent**.
2. Invite le bot (OAuth2 › URL Generator › `bot` + `applications.commands`) avec les permissions :
   Gérer les salons, Gérer les rôles, Gérer les webhooks, Voir les salons, Envoyer des messages, Intégrer des liens.
3. Sur le serveur : mets le rôle du bot **au-dessus** du rôle « employé » (sinon il ne pourra pas le retirer avec `/virer`).
4. Vérifie que la catégorie « Casiers » autorise le bot à y créer des salons.

## 2. Héberger le bot (il doit tourner 24h/24)
Netlify ne peut pas faire tourner un bot : utilise Railway, Render, ou un petit serveur.
Envoie-y ce dossier, commande de démarrage `npm start`, et remplis les variables de `.env.example`
(⚠️ le token ne va JAMAIS dans GitHub : uniquement dans les variables de l'hébergeur).
L'hébergeur te donne une adresse publique (ex. `https://docktease-bot.up.railway.app`) : c'est le `BOT_URL`.

## 3. Côté site (Netlify › Site configuration › Environment variables)
- `BOT_API_KEY` : **exactement la même** clé que dans le bot.
- `BOT_URL` : l'adresse publique du bot (sans `/` à la fin).
Puis redéploie le site avec les fichiers de `docktease-netlify`.

## 4. Test rapide
1. Donne le rôle employé à un compte test : le casier apparaît avec le message de bienvenue.
2. Connecte-toi au site avec ce compte Discord, remplis la fiche : elle arrive dans le casier avec **Accepter / Refuser / Virer**.
3. Ajoute une vente avec ce compte : elle s'affiche dans le casier.

## Commandes (direction uniquement)
- `/virer membre` : accès au site coupé, rôle retiré, casier verrouillé.
- `/casier creer membre` : crée le casier à la main.
- `/casier reparer membre` : recrée le webhook si les ventes n'arrivent plus.
- `/casier fiche membre` : reposte la fiche si le message n'est pas arrivé.
- `/casier sync` : crée tous les casiers manquants. (Le bot le fait aussi tout seul à chaque démarrage.)
