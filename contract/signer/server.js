// ngrbet backend: points ledger + EIP-712 voucher signer for NgrbetRewards.
//
//   GET  /config                                  contract + chain + farming params
//   GET  /auth/nonce?wallet=0x..                  message to sign with the wallet
//   POST /auth/verify   { wallet, signature }     -> { token, wallet }
//   GET  /me                        (Bearer)      points, pending voucher, claim preview
//   POST /points/earn               (Bearer)      one "round played": server-side rate limited
//   POST /claim/sign                (Bearer)      debit points, return voucher + calldata
//   POST /points/add    { wallet, points }        admin credit, header x-api-key
//   GET  /points/:wallet                          public read
//   GET  /  + /assets/*                           the game itself (SERVE_GAME=1)
//
// The browser is never trusted with a points amount: /points/earn awards a fixed
// POINTS_PER_ROUND at most once per EARN_COOLDOWN_SECONDS per wallet, capped by
// DAILY_POINTS_CAP. Vouchers are cached as "pending" until the on-chain nonce moves
// (claim done) or the deadline passes (points refunded).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ethers } = require('ethers');

const env = process.env;
for (const k of ['SIGNER_PRIVATE_KEY', 'CONTRACT_ADDRESS', 'RPC_URL', 'CHAIN_ID', 'API_KEY']) {
  if (!env[k]) { console.error(`missing env ${k}`); process.exit(1); }
}
const {
  SIGNER_PRIVATE_KEY, CONTRACT_ADDRESS, RPC_URL, CHAIN_ID, API_KEY,
  PORT = 8787,
  POINTS_PER_ROUND = 100,
  EARN_COOLDOWN_SECONDS = 8,
  DAILY_POINTS_CAP = 20000,
  VOUCHER_TTL_SECONDS = 3600,
  SESSION_TTL_SECONDS = 7 * 86400,
  SERVE_GAME = '1',
  CORS_ORIGIN = '*',
  EXPLORER_URL = Number(CHAIN_ID) === 4663
    ? 'https://robinhoodchain.blockscout.com'
    : 'https://explorer.testnet.chain.robinhood.com',
  CHAIN_NAME = Number(CHAIN_ID) === 4663 ? 'Robinhood Chain' : 'Robinhood Chain Testnet',
} = env;
const SESSION_SECRET = env.SESSION_SECRET || crypto.createHash('sha256').update('ngrbet-session:' + SIGNER_PRIVATE_KEY).digest('hex');

const LEDGER = path.join(__dirname, '..', 'data', 'points.json');
const GAME_ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------- chain
const ABI = [
  'function nonces(address) view returns (uint256)',
  'function threshold() view returns (uint256)',
  'function pointsForMax() view returns (uint256)',
  'function minPayout() view returns (uint256)',
  'function maxPayout() view returns (uint256)',
  'function cooldown() view returns (uint256)',
  'function nextClaimAt(address) view returns (uint256)',
  'function payoutFor(uint256) view returns (uint256)',
  'function paused() view returns (bool)',
  'function claim(uint256 points, uint256 deadline, bytes signature)',
];
const provider = new ethers.JsonRpcProvider(RPC_URL, Number(CHAIN_ID));
const wallet = new ethers.Wallet(SIGNER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
const iface = new ethers.Interface(ABI);

const domain = { name: 'ngrbet rewards', version: '1', chainId: Number(CHAIN_ID), verifyingContract: CONTRACT_ADDRESS };
const types = {
  Claim: [
    { name: 'player', type: 'address' },
    { name: 'points', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

let paramsCache = { at: 0, v: null };
async function params() {
  if (Date.now() - paramsCache.at < 60_000 && paramsCache.v) return paramsCache.v;
  const [threshold, pointsForMax, minPayout, maxPayout, cooldown, paused] = await Promise.all([
    contract.threshold(), contract.pointsForMax(), contract.minPayout(), contract.maxPayout(), contract.cooldown(), contract.paused(),
  ]);
  paramsCache = { at: Date.now(), v: { threshold, pointsForMax, minPayout, maxPayout, cooldown, paused } };
  return paramsCache.v;
}
// same formula as the contract, to preview without an RPC call
function payoutFor(points, p) {
  points = BigInt(points);
  if (points < p.threshold) return 0n;
  if (points >= p.pointsForMax) return p.maxPayout;
  return p.minPayout + ((p.maxPayout - p.minPayout) * (points - p.threshold)) / (p.pointsForMax - p.threshold);
}

// ---------------------------------------------------------------- ledger
function load() {
  try { return { points: {}, pending: {}, earn: {}, nonces: {}, ...JSON.parse(fs.readFileSync(LEDGER, 'utf8')) }; }
  catch { return { points: {}, pending: {}, earn: {}, nonces: {} }; }
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify(db, null, 2));
  }, 50);
}
const db = load();
const key = (a) => ethers.getAddress(a).toLowerCase();
const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);

async function reconcile(w) {
  const p = db.pending[w];
  if (!p) return null;
  const onChainNonce = Number(await contract.nonces(w));
  if (onChainNonce > p.nonce) { delete db.pending[w]; save(); return null; }            // claimed
  if (now() > p.deadline) {                                                                // expired: refund
    db.points[w] = (db.points[w] || 0) + p.points;
    delete db.pending[w]; save(); return null;
  }
  return p;
}

// ---------------------------------------------------------------- sessions
const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString();
const hmac = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
function issueToken(w) {
  const payload = b64(JSON.stringify({ w, exp: now() + Number(SESSION_TTL_SECONDS) }));
  return `${payload}.${hmac(payload)}`;
}
function readToken(t) {
  if (!t || !t.includes('.')) return null;
  const [payload, sig] = t.split('.');
  const expected = hmac(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { const d = JSON.parse(unb64(payload)); return d.exp > now() ? d.w : null; } catch { return null; }
}
function auth(req, res, next) {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const w = readToken(t);
  if (!w) return res.status(401).json({ error: 'not logged in' });
  req.wallet = w;
  next();
}
const loginMessage = (w, nonce) => `ngrbet login\nwallet: ${w}\nnonce: ${nonce}`;

async function meFor(w) {
  const p = await params();
  const pending = await reconcile(w);
  const points = db.points[w] || 0;
  const e = db.earn[w] || {};
  const nextAt = Number(await contract.nextClaimAt(w));
  const dayPoints = e.day === today() ? e.dayPoints || 0 : 0;
  return {
    wallet: w,
    points,
    pending,
    threshold: p.threshold.toString(),
    pointsForMax: p.pointsForMax.toString(),
    payoutWei: payoutFor(points, p).toString(),
    canClaim: !p.paused && BigInt(points) >= p.threshold && nextAt <= now() && !pending,
    nextClaimAt: nextAt,
    nextEarnAt: (e.last || 0) + Number(EARN_COOLDOWN_SECONDS),
    dailyLeft: Math.max(0, Number(DAILY_POINTS_CAP) - dayPoints),
    paused: p.paused,
  };
}

// ---------------------------------------------------------------- http
const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
app.use(express.json({ limit: '16kb' }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'server error' }); });

app.get('/config', wrap(async (_req, res) => {
  const p = await params();
  res.json({
    contract: CONTRACT_ADDRESS, chainId: Number(CHAIN_ID), chainName: CHAIN_NAME, rpc: RPC_URL, explorer: EXPLORER_URL,
    signer: wallet.address,
    threshold: p.threshold.toString(), pointsForMax: p.pointsForMax.toString(),
    minPayoutWei: p.minPayout.toString(), maxPayoutWei: p.maxPayout.toString(), cooldown: Number(p.cooldown), paused: p.paused,
    pointsPerRound: Number(POINTS_PER_ROUND), earnCooldown: Number(EARN_COOLDOWN_SECONDS), dailyCap: Number(DAILY_POINTS_CAP),
  });
}));

app.get('/auth/nonce', (req, res) => {
  const w = req.query.wallet;
  if (!ethers.isAddress(w || '')) return res.status(400).json({ error: 'bad address' });
  const k = key(w);
  const nonce = crypto.randomBytes(16).toString('hex');
  db.nonces[k] = { nonce, exp: now() + 600 };
  save();
  res.json({ nonce, message: loginMessage(ethers.getAddress(w), nonce) });
});

app.post('/auth/verify', (req, res) => {
  const { wallet: w, signature } = req.body || {};
  if (!ethers.isAddress(w || '') || typeof signature !== 'string') return res.status(400).json({ error: 'wallet and signature required' });
  const k = key(w);
  const n = db.nonces[k];
  if (!n || n.exp < now()) return res.status(400).json({ error: 'nonce expired, ask again' });
  let recovered;
  try { recovered = ethers.verifyMessage(loginMessage(ethers.getAddress(w), n.nonce), signature).toLowerCase(); } catch { recovered = null; }
  if (recovered !== k) return res.status(401).json({ error: 'bad signature' });
  delete db.nonces[k]; save();
  res.json({ token: issueToken(k), wallet: k });
});

app.get('/me', auth, wrap(async (req, res) => res.json(await meFor(req.wallet))));

app.post('/points/earn', auth, wrap(async (req, res) => {
  const w = req.wallet;
  const e = db.earn[w] || { last: 0, day: today(), dayPoints: 0 };
  if (e.day !== today()) { e.day = today(); e.dayPoints = 0; }
  const t = now();
  let awarded = 0;
  if (t - e.last >= Number(EARN_COOLDOWN_SECONDS) && e.dayPoints < Number(DAILY_POINTS_CAP)) {
    awarded = Math.min(Number(POINTS_PER_ROUND), Number(DAILY_POINTS_CAP) - e.dayPoints);
    e.last = t; e.dayPoints += awarded;
    db.points[w] = (db.points[w] || 0) + awarded;
  }
  db.earn[w] = e; save();
  res.json({ awarded, me: await meFor(w) });
}));

app.post('/claim/sign', auth, wrap(async (req, res) => {
  const k = req.wallet;
  const p = await params();
  if (p.paused) return res.status(503).json({ error: 'claims are paused' });

  const pending = await reconcile(k);
  if (pending) return res.json(pending);

  const [nextAt, nonce] = await Promise.all([contract.nextClaimAt(k), contract.nonces(k)]);
  const points = db.points[k] || 0;
  if (BigInt(points) < p.threshold) {
    return res.status(400).json({ error: 'not enough points', points, threshold: p.threshold.toString() });
  }
  if (Number(nextAt) > now()) return res.status(429).json({ error: 'cooldown', availableAt: Number(nextAt) });

  const deadline = now() + Number(VOUCHER_TTL_SECONDS);
  const signature = await wallet.signTypedData(domain, types, {
    player: ethers.getAddress(k), points: BigInt(points), nonce, deadline,
  });
  const amountWei = payoutFor(points, p).toString();
  const calldata = iface.encodeFunctionData('claim', [BigInt(points), BigInt(deadline), signature]);

  const v = { wallet: k, points, nonce: Number(nonce), deadline, signature, amountWei, calldata, to: CONTRACT_ADDRESS, chainId: Number(CHAIN_ID) };
  db.points[k] = 0;           // whole balance is redeemed
  db.pending[k] = v;
  save();
  res.json(v);
}));

app.post('/points/add', (req, res) => {
  if (req.get('x-api-key') !== API_KEY) return res.status(401).json({ error: 'bad api key' });
  const { wallet: w, points } = req.body || {};
  if (!ethers.isAddress(w || '') || !Number.isInteger(points) || points <= 0) {
    return res.status(400).json({ error: 'wallet (address) and points (positive int) required' });
  }
  const k = key(w);
  db.points[k] = (db.points[k] || 0) + points;
  save();
  res.json({ wallet: k, points: db.points[k] });
});

app.get('/points/:wallet', wrap(async (req, res) => {
  if (!ethers.isAddress(req.params.wallet)) return res.status(400).json({ error: 'bad address' });
  const k = key(req.params.wallet);
  const pending = await reconcile(k);
  res.json({ wallet: k, points: db.points[k] || 0, pending });
}));

// the game itself (only index.html and assets/, never the contract folder)
if (SERVE_GAME === '1') {
  app.get('/', (_req, res) => res.sendFile(path.join(GAME_ROOT, 'index.html')));
  app.use('/assets', express.static(path.join(GAME_ROOT, 'assets')));
}

app.listen(Number(PORT), () => {
  console.log(`ngrbet backend on :${PORT}`);
  console.log(`  signer   ${wallet.address}`);
  console.log(`  contract ${CONTRACT_ADDRESS} (chain ${CHAIN_ID})`);
  console.log(`  farming  ${POINTS_PER_ROUND} pts / round, 1 round per ${EARN_COOLDOWN_SECONDS}s, ${DAILY_POINTS_CAP} pts / day`);
  if (SERVE_GAME === '1') console.log(`  game     http://localhost:${PORT}/`);
});
