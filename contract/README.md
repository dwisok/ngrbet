# ngrbet rewards (Robinhood Chain)

Les joueurs farment des points dans le jeu. À partir d'un seuil, ils réclament de l'ETH
sur leur wallet. Le montant va de **0.001 ETH** (au seuil) à **0.1 ETH** (au plafond de points),
en progression linéaire. Le contrat est alimenté par le propriétaire et paie sur son propre solde.

## Comment ça marche

```
jeu (points)  ->  signer (backend)  ->  voucher EIP-712  ->  joueur  ->  claim()  ->  ETH
```

1. Le backend tient le registre des points par wallet (`signer/server.js`, fichier `data/points.json`).
2. Quand un joueur a au moins `threshold` points, le backend signe un voucher
   `Claim(player, points, nonce, deadline)` avec la clé `SIGNER_PRIVATE_KEY`.
3. Le joueur appelle `claim(points, deadline, signature)` depuis son wallet. Le contrat vérifie la
   signature, le nonce (anti-rejeu), le cooldown, puis envoie `payoutFor(points)` en ETH.

Le contrat ne fait confiance qu'au signer. **Les points du jeu actuel sont stockés côté navigateur
(localStorage), donc falsifiables.** Pour payer de l'ETH réel, il faut que le jeu crédite les points
via `POST /points/add` depuis un serveur, pas depuis le navigateur.

## Paramètres du contrat

| Paramètre      | Défaut     | Rôle                                        |
|----------------|------------|---------------------------------------------|
| `threshold`    | 10 000 pts | minimum pour réclamer, paie `minPayout`     |
| `pointsForMax` | 1 000 000  | à partir de là, paie `maxPayout`            |
| `minPayout`    | 0.001 ETH  |                                              |
| `maxPayout`    | 0.1 ETH    |                                              |
| `cooldown`     | 86 400 s   | une réclamation par wallet et par 24 h       |

Tout est modifiable par le owner (`setPayouts`, `setCooldown`, `setSigner`), et le contrat est
pausable (`pause` / `unpause`). `withdraw` permet de récupérer l'ETH du pool.

## Réseau

| Réseau  | Chain ID | RPC                                         | Explorer                                    |
|---------|----------|---------------------------------------------|---------------------------------------------|
| Mainnet | 4663     | https://rpc.mainnet.chain.robinhood.com     | https://robinhoodchain.blockscout.com       |
| Testnet | 46630    | https://rpc.testnet.chain.robinhood.com     | https://explorer.testnet.chain.robinhood.com |

Faucet testnet : https://faucet.testnet.chain.robinhood.com

## Installation et tests

```bash
cd contract
npm install
npm test
```

## Déploiement

```bash
cp .env.example .env      # remplir PRIVATE_KEY, SIGNER_PRIVATE_KEY, paramètres
npm run deploy:testnet    # ou npm run deploy pour le mainnet
```

Le script affiche l'adresse et la commande `hardhat verify` à lancer pour publier le code sur Blockscout.
Pour alimenter le pool, envoie simplement de l'ETH à l'adresse du contrat (`FUND_ETH` dans `.env`
le fait juste après le déploiement).

## Backend (signer + registre de points + hébergement du jeu)

```bash
npm run signer        # http://localhost:8787 : API + le jeu lui-même
```

Le backend sert aussi `index.html` et `assets/` (désactivable avec `SERVE_GAME=0`). Si le jeu est
hébergé ailleurs, mets l'URL du backend dans la balise `<meta name="ngrbet-api">` de `index.html`
et liste le domaine du jeu dans `CORS_ORIGIN`.

| Route                    | Auth      | Rôle                                                        |
|--------------------------|-----------|-------------------------------------------------------------|
| `GET  /config`           |           | contrat, chaîne, seuils, paramètres de farming              |
| `GET  /auth/nonce`       |           | message à signer avec le wallet (`?wallet=0x..`)            |
| `POST /auth/verify`      |           | vérifie la signature, renvoie un token de session (7 j)     |
| `GET  /me`               | Bearer    | points, voucher en attente, ETH réclamable, prochains délais |
| `POST /points/earn`      | Bearer    | un round joué : `POINTS_PER_ROUND`, max 1 par `EARN_COOLDOWN_SECONDS`, plafond `DAILY_POINTS_CAP` par jour |
| `POST /claim/sign`       | Bearer    | débite tous les points, renvoie voucher signé + calldata prêt à envoyer |
| `POST /points/add`       | x-api-key | crédit manuel (admin)                                       |
| `GET  /points/:wallet`   |           | lecture publique                                            |

**Le navigateur n'envoie jamais un montant de points.** Il signale juste « un round a été joué »,
et c'est le serveur qui décide combien créditer, avec un rythme maximal par wallet. Avec les
valeurs par défaut : 100 pts par round, un round toutes les 8 s, 20 000 pts par jour, donc le seuil
de 10 000 pts (0.001 ETH) se farme en 100 rounds, environ 15 minutes.

Un voucher est valable une heure. S'il n'est pas utilisé, les points sont recrédités.

## Côté jeu

Tout est branché dans `index.html` : bouton **Wallet** dans l'en-tête, connexion MetaMask (ou tout
wallet EVM) par signature de message, points crédités à chaque gain, bouton **CLAIM ETH** qui bascule
le wallet sur Robinhood Chain et envoie la transaction `claim` avec le calldata fourni par le backend.
Le jeu ne charge aucune librairie web3 : il parle directement à `window.ethereum`.

## À garder en tête

- Distribuer de l'ETH réel à des joueurs peut relever de la réglementation sur les jeux d'argent
  ou les promotions selon le pays. À vérifier avant le mainnet.
- Le contrat ne garde jamais de clé : la clé du signer vit uniquement sur le backend.
- Ne commite jamais `.env`.

## Déploiements

| Réseau  | Adresse                                      | Explorer |
|---------|----------------------------------------------|----------|
| Mainnet | `0x6995Bd3920d5283E4d5E5d14379cA399c8935634` | https://robinhoodchain.blockscout.com/address/0x6995Bd3920d5283E4d5E5d14379cA399c8935634 |

Déployé le 2026-09-03 avec les paramètres par défaut (seuil 10 000 pts, plafond 1 000 000 pts, 0.001 à 0.1 ETH, cooldown 24 h).
Signer : `0x755A4574538F3A3dd5d958A7d48C358b2804B74d`.
