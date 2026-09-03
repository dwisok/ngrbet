# ngrbet

Le casino où perdre n'a jamais été dessiné. Aucun argent, aucune perte, toujours en brouillon.

## Lancer en local

```bash
npm start
```

Ça lance un petit serveur sans aucune dépendance et ouvre http://localhost:5173 dans le navigateur. Pas besoin de `npm install` pour ça.

Pour le mode dev avec rechargement automatique (Vite) :

```bash
npm install
npm run dev
```

## Mettre en ligne (Hostinger ou autre hébergeur statique)

```bash
npm run build
```

Le dossier `dist/` contient le site prêt à déployer : envoie son contenu dans `public_html`.
(`npm run preview` permet de vérifier le build avant l'envoi.)

## Structure

- `index.html` — tout le site : HTML, CSS, JS et les dessins générés en canvas.
- `vite.config.js` — config Vite (chemins relatifs pour que le build marche dans n'importe quel sous-dossier).
