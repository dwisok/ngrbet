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

## Service de signature

```bash
npm run signer
```

| Route                    | Rôle                                                   |
|--------------------------|--------------------------------------------------------|
| `POST /points/add`       | crédite des points (header `x-api-key`)                |
| `GET  /points/:wallet`   | solde de points et voucher en attente                  |
| `POST /claim/sign`       | débite les points, renvoie le voucher signé            |
| `GET  /config`           | paramètres du contrat                                  |

Un voucher est valable une heure. S'il n'est pas utilisé, les points sont recrédités.

## Côté jeu (à brancher)

```js
const res = await fetch(SIGNER_URL + '/claim/sign', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ wallet: account }),
});
const { points, deadline, signature } = await res.json();
const rewards = new ethers.Contract(CONTRACT_ADDRESS, ['function claim(uint256,uint256,bytes)'], walletSigner);
await rewards.claim(points, deadline, signature);
```

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
