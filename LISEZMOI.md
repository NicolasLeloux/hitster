# Hitster maison : application mobile

Web app installable sur l'écran d'accueil (iPhone et Android), sans App Store ni mode développeur.
Elle scanne une carte, puis fait jouer la chanson par l'app Spotify du téléphone sans jamais afficher le titre.

## Pourquoi ce choix
- Une vraie app iOS demande un compte Apple Developer (99 €/an) ou une réinstallation tous les 7 jours. Une web app installée depuis Safari n'a aucune de ces contraintes.
- Spotify ne permet pas de jouer la musique directement dans un navigateur mobile (le Web Playback SDK ne fonctionne pas sur mobile, et les extraits de 30 s ont été supprimés de l'API). L'app pilote donc l'app Spotify du téléphone via Spotify Connect.
- Conséquences : compte **Spotify Premium** obligatoire, l'app Spotify doit être installée et ouverte une fois, et l'écran de verrouillage / la notification Spotify affichent le titre (il suffit de ne pas les regarder).

## Format des QR codes
L'ID Spotify seul, 22 caractères (c'est ce que génère le dossier `cards/`) : l'appareil photo natif n'en fait rien, donc rien n'est révélé. Acceptés aussi : `spotify:track:<ID>` ou une URL `https://open.spotify.com/track/<ID>` (déconseillé : l'appareil photo natif l'ouvrirait et révélerait le titre).

## Mise en place (une seule fois)
1. **Héberger l'app en HTTPS** (obligatoire pour la caméra et la connexion Spotify), par exemple GitHub Pages : copier tout le dossier `app/` dans un dépôt et activer Pages. L'adresse ressemble à `https://<compte>.github.io/<depot>/`.
2. **Créer une app Spotify** sur https://developer.spotify.com/dashboard :
   - Redirect URI : l'adresse exacte de l'étape 1, avec le `/` final.
   - API utilisée : *Web API*.
   - Dans *User Management*, ajouter l'adresse e-mail Spotify de chaque joueur qui se connectera (mode développement, quelques comptes max).
   - Copier le **Client ID** dans `config.js` (ou le saisir dans l'app au premier lancement).
3. **Sur le téléphone** : ouvrir l'adresse dans Safari (iPhone) ou Chrome (Android), puis *Partager → Sur l'écran d'accueil* (iPhone) ou *⋮ → Installer l'application* (Android).

## Utilisation
1. Ouvrir l'app Spotify une fois (pour qu'elle soit visible comme appareil), revenir dans Hitster.
2. *Scanner une carte* → la musique démarre ; lecture/pause, −10 s / +10 s, barre de progression.
3. Le bouton en haut à droite permet de choisir un autre appareil (enceinte, ordinateur…).

Le morceau est mis en répétition pour que Spotify n'enchaîne pas sur une autre chanson.

## Fichiers
- `index.html`, `style.css`, `app.js` : l'application
- `config.js` : Client ID Spotify
- `sw.js`, `manifest.webmanifest`, `icons/` : installation sur l'écran d'accueil
- `vendor/jsQR.js` : lecture des QR codes sur iPhone (licence Apache 2.0)
