// ngrbet signer service
// Keeps the points ledger and issues EIP-712 claim vouchers for NgrbetRewards.
//
//   POST /points/add        { wallet, points }        header x-api-key   -> credit points
//   GET  /points/:wallet                                                  -> { points, pending }
//   POST /claim/sign        { wallet }                                    -> { points, nonce, deadline, signature, amountWei }
//   GET  /config                                                          -> contract params
//
// Points are debited when a voucher is issued. The voucher is cached as
// "pending" and re-served until the on-chain nonce moves (claim done) or the
// deadline passes (points are refunded).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const {
  SIGNER_PRIVATE_KEY, CONTRACT_ADDRESS, RPC_URL, CHAIN_ID, API_KEY, PORT = 8787,
} = process.env;
for (const k of ['SIGNER_PRIVATE_KEY', 'CONTRACT_ADDRESS', 'RPC_URL', 'CHAIN_ID', 'API_KEY']) {
  if (!process.env[k]) { console.error(`missing env ${k}`); process.exit(1); }
}

const VOUCHER_TTL = 60 * 60; // seconds
const LEDGER = path.join(__dirname, '..', 'data', 'points.json');

const ABI = [
  'function nonces(address) view returns (uint256)',
  'function threshold() view returns (uint256)',
  'function pointsForMax() view returns (uint256)',
  'function minPayout() view returns (uint256)',
  'function maxPayout() view returns (uint256)',
  'function cooldown() view returns (uint256)',
  'function nextClaimAt(address) view returns (uint256)',
  'function payoutFor(uint256) view returns (uint256)',
];

const provider = new ethers.JsonRpcProvider(RPC_URL, Number(CHAIN_ID));
const wallet = new ethers.Wallet(SIGNER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

const domain = { name: 'ngrbet rewards', version: '1', chainId: Number(CHAIN_ID), verifyingContract: CONTRACT_ADDRESS };
const types = {
  Claim: [
    { name: 'player', type: 'address' },
    { name: 'points', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// ---------------------------------------------------------------- ledger
function load() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { points: {}, pending: {} }; }
}
function save(db) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(db, null, 2));
}
const db = load();
const key = (a) => ethers.getAddress(a).toLowerCase();
const now = () => Math.floor(Date.now() / 1000);

// Reconcile a wallet's pending voucher with chain state.
async function reconcile(w) {
  const p = db.pending[w];
  if (!p) return null;
  const onChainNonce = Number(await contract.nonces(w));
  if (onChainNonce > p.nonce) { delete db.pending[w]; save(db); return null; } // claimed
  if (now() > p.deadline) { // expired: refund
    db.points[w] = (db.points[w] || 0) + p.points;
    delete db.pending[w]; save(db); return null;
  }
  return p;
}

// ---------------------------------------------------------------- http
const app = express();
app.use(cors());
app.use(express.json());

app.get('/config', async (_req, res) => {
  const [threshold, pointsForMax, minPayout, maxPayout, cooldown] = await Promise.all([
    contract.threshold(), contract.pointsForMax(), contract.minPayout(), contract.maxPayout(), contract.cooldown(),
  ]);
  res.json({
    contract: CONTRACT_ADDRESS, chainId: Number(CHAIN_ID), signer: wallet.address,
    threshold: threshold.toString(), pointsForMax: pointsForMax.toString(),
    minPayoutWei: minPayout.toString(), maxPayoutWei: maxPayout.toString(), cooldown: Number(cooldown),
  });
});

app.post('/points/add', (req, res) => {
  if (req.get('x-api-key') !== API_KEY) return res.status(401).json({ error: 'bad api key' });
  const { wallet: w, points } = req.body || {};
  if (!ethers.isAddress(w || '') || !Number.isInteger(points) || points <= 0) {
    return res.status(400).json({ error: 'wallet (address) and points (positive int) required' });
  }
  const k = key(w);
  db.points[k] = (db.points[k] || 0) + points;
  save(db);
  res.json({ wallet: k, points: db.points[k] });
});

app.get('/points/:wallet', async (req, res) => {
  if (!ethers.isAddress(req.params.wallet)) return res.status(400).json({ error: 'bad address' });
  const k = key(req.params.wallet);
  const pending = await reconcile(k);
  res.json({ wallet: k, points: db.points[k] || 0, pending });
});

app.post('/claim/sign', async (req, res) => {
  try {
    const { wallet: w } = req.body || {};
    if (!ethers.isAddress(w || '')) return res.status(400).json({ error: 'bad address' });
    const k = key(w);

    const pending = await reconcile(k);
    if (pending) return res.json(pending); // same voucher until it is used or expires

    const [threshold, nextAt, nonce] = await Promise.all([
      contract.threshold(), contract.nextClaimAt(k), contract.nonces(k),
    ]);
    const points = db.points[k] || 0;
    if (BigInt(points) < threshold) {
      return res.status(400).json({ error: 'not enough points', points, threshold: threshold.toString() });
    }
    if (Number(nextAt) > now() && (await provider.getBlock('latest')).timestamp < Number(nextAt)) {
      return res.status(429).json({ error: 'cooldown', availableAt: Number(nextAt) });
    }

    const deadline = now() + VOUCHER_TTL;
    const signature = await wallet.signTypedData(domain, types, {
      player: ethers.getAddress(k), points: BigInt(points), nonce, deadline,
    });
    const amountWei = (await contract.payoutFor(BigInt(points))).toString();

    const v = { wallet: k, points, nonce: Number(nonce), deadline, signature, amountWei };
    db.points[k] = 0;          // debit: the whole balance is redeemed
    db.pending[k] = v;
    save(db);
    res.json(v);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'signer error' });
  }
});

app.listen(Number(PORT), () => {
  console.log(`ngrbet signer ${wallet.address} on :${PORT} -> ${CONTRACT_ADDRESS} (chain ${CHAIN_ID})`);
});
