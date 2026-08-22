const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 5177;
const RESULT_CAP = 20000;
const CONNECT_SERVER_SELECTION_MS = 8000;
const IMAGES_QUERY_MAX_TIME_MS = 30000;
const DEBUG_QUERY_MAX_TIME_MS = 15000;
const MIN_FLOOR_NUMBER = 10000;
const STATIC_SALE_TYPES = ['po1', 'po1h', 'po2', 'po3'];
const DYNAMIC_SALE_TYPES = ['1', '2', '3'];

const POPUP_ID_PATTERN = /^popup:(\d+)$/;
const MIN_AVAILABLE_POPUP_ID = 10000;

// Which field holds a prize's quantity, and whether that field is
// cents-denominated (÷100 before display), keyed by the prize's giftType.
// giftTypes not listed here (including 6/30/37/39, which never carry a
// meaningful amount) fall back to "icon only, no amount" — reverse-engineered
// from real catalog documents, not a spec, so don't assume a gap is a bug.
const GIFT_TYPE_AMOUNT_RULES = {
  1: { field: 'babaCoins', cents: false },
  8: { field: 'babaCoinsMulti', cents: false },
  13: { field: 'amountOfGameKeys', cents: false },
  40: { field: 'amountOfGameKeys', cents: false },
  32: { field: 'amountOfItems', cents: true },
  35: { field: 'amountOfItems', cents: true },
  45: { field: 'amountOfItems', cents: true },
  38: { field: 'gemsCent', cents: true },
  42: { field: 'amountOfItems', cents: false },
  43: { field: 'amountOfItems', cents: false },
  44: { field: 'amountOfItems', cents: false },
};

// Precedence when the same prize id is defined in more than one catalog:
// earlier entries win. Merge logic in resolveAvailablePrizes() depends on
// this exact ordering — see the comment there before reordering this list.
const AVAILABLE_PRIZES_CATALOG_IDS = [
  'managerAvailablePrizes',
  'managerAvailablePrizes:100',
  'managerAvailablePrizesCards:0',
];

// ENP-style dynamicPrices entries never resolve to a real prize id, so their
// icon(s) are hardcoded rather than looked up by giftType — temporary until
// there's a reliable catalog-backed source for them. Most popup types show
// both GC and SC icons; boxTokensMultiple popups reward a single currency
// (tokens), so they show just the one Tokens icon instead, and gcMultiple
// popups show just the one GC icon (ENP_ICON_URLS[0]) — see the doc.type
// checks in resolveAvailablePrizes().
const ENP_ICON_URLS = [
  'https://s3cdn.babawildslots.com/uploadImages/PlainCoin_Icon.png', // GC
  'https://s3cdn.babawildslots.com/uploadImages/SC_CoinIcon.png', // SC
];
const ENP_TOKENS_ICON_URL = 'https://s3cdn.babawildslots.com/uploadImages/StarToken_CoinIcon.png';

// Auth only activates when APP_PASSWORD is set (i.e. a real hosted deployment).
// Local single-user usage via the one-click launchers has no env vars set, so
// it behaves exactly as before: no login screen, connect straight away.
const AUTH_ENABLED = Boolean(process.env.APP_PASSWORD);

// Binding to all interfaces is only safe once auth is actually gating every
// route — never widen this independently of AUTH_ENABLED.
const HOST = AUTH_ENABLED ? '0.0.0.0' : '127.0.0.1';

const SESSION_IDLE_MS = 45 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function computeAvailability(existingIds, { limit = 5, start = MIN_AVAILABLE_POPUP_ID } = {}) {
  const taken = new Set();
  for (const id of existingIds) {
    const match = POPUP_ID_PATTERN.exec(id);
    if (match) taken.add(Number(match[1]));
  }

  const gaps = [];
  let candidate = start;
  while (gaps.length < limit) {
    if (!taken.has(candidate)) gaps.push(candidate);
    candidate++;
  }

  const [next, ...upcoming] = gaps;
  return {
    next: `popup:${next}`,
    upcoming: upcoming.map((n) => `popup:${n}`),
  };
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

const DB_NAME = 'sweepStakes';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: 'auto',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// Per-session MongoDB connections. Never a shared/global client+db — each
// browser session gets its own isolated connection, keyed by session id, so
// one person's connected database can never leak into another session's
// requests. Idle sessions have their connection closed and evicted after
// SESSION_IDLE_MS so tabs left open don't hold connections forever.
const connections = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, entry] of connections) {
    if (now - entry.lastUsed > SESSION_IDLE_MS) {
      log(`session: evicting idle connection for session ${sessionId}`);
      entry.client.close().catch(() => {});
      connections.delete(sessionId);
    }
  }
}, SESSION_SWEEP_INTERVAL_MS);

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED || req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated.' });
}

function requireDb(req, res, next) {
  const entry = connections.get(req.session.id);
  if (!entry) {
    return res.status(400).json({ error: 'Not connected yet.' });
  }
  entry.lastUsed = Date.now();
  req.db = entry.db;
  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

app.get('/api/session', (req, res) => {
  res.json({
    authEnabled: AUTH_ENABLED,
    authenticated: AUTH_ENABLED ? Boolean(req.session.authenticated) : true,
  });
});

app.post('/api/login', loginLimiter, (req, res) => {
  if (!AUTH_ENABLED) {
    return res.json({ ok: true });
  }
  const { password } = req.body || {};
  if (typeof password === 'string' && password === process.env.APP_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Incorrect password.' });
});

app.post('/api/logout', (req, res) => {
  const entry = connections.get(req.session.id);
  if (entry) {
    entry.client.close().catch(() => {});
    connections.delete(req.session.id);
  }
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/connect', requireAuth, async (req, res) => {
  const { uri } = req.body || {};
  if (!uri || typeof uri !== 'string') {
    return res.status(400).json({ error: 'Missing connection URI.' });
  }

  log('connect: request received');
  const start = Date.now();
  const previous = connections.get(req.session.id);
  try {
    const newClient = new MongoClient(uri, {
      serverSelectionTimeoutMS: CONNECT_SERVER_SELECTION_MS,
    });
    await newClient.connect();
    const newDb = newClient.db(DB_NAME);
    await newDb.command({ ping: 1 });

    connections.set(req.session.id, { client: newClient, db: newDb, lastUsed: Date.now() });
    if (previous) await previous.client.close().catch(() => {});

    log(`connect: success, db="${newDb.databaseName}" (${Date.now() - start}ms)`);
    res.json({ ok: true, dbName: newDb.databaseName });
  } catch (err) {
    log(`connect: failed after ${Date.now() - start}ms —`, err.message);
    res.status(500).json({
      error: 'Could not connect. Check the URI, then try again.',
    });
  }
});

function computePrizeAmount(prize) {
  const rule = GIFT_TYPE_AMOUNT_RULES[prize.giftType];
  if (!rule) return null;
  const raw = prize[rule.field];
  if (typeof raw !== 'number') return null;
  const value = rule.cents ? raw / 100 : raw;
  return value.toLocaleString('en-US');
}

// Merges both catalog docs' availablePrizes[] into one id -> prize lookup,
// then resolves the viewed popup's availablePrizesByGroupId against it.
// managerAvailablePrizes wins over managerAvailablePrizes:100 if the same id
// is defined in both (rare, but possible) — never cached, since the catalog
// can be edited by the team while this tool is in use.
//
// Returns one cluster per tier, each with its resolved catalog prizes plus,
// when that tier's dynamicPrices entry is a placeholder string rather than a
// number, an enpItems pair (hardcoded ENP_ICON_URLS, not looked up — see its
// comment). dynamicPrices entries line up by position with groups sorted
// ascending by key (dynamicPrices[0] is tier/group 1, dynamicPrices[1] is
// tier/group 2, etc) — but the returned clusters are reversed for display,
// so the highest tier/group renders first.
async function resolveAvailablePrizes(db, doc) {
  const groupMap = doc.availablePrizesByGroupId;
  if (!groupMap || typeof groupMap !== 'object' || Object.keys(groupMap).length === 0) {
    return [];
  }

  const catalogDocs = await Promise.all(
    AVAILABLE_PRIZES_CATALOG_IDS.map((id) =>
      db
        .collection('managers')
        .findOne({ _id: id }, { maxTimeMS: DEBUG_QUERY_MAX_TIME_MS })
        .catch(() => null)
    )
  );

  const prizeById = new Map();
  // Reversed so managerAvailablePrizes (first in AVAILABLE_PRIZES_CATALOG_IDS)
  // is inserted last and therefore wins on conflicting ids.
  for (const catalogDoc of [...catalogDocs].reverse()) {
    if (!catalogDoc || !Array.isArray(catalogDoc.availablePrizes)) continue;
    for (const prize of catalogDoc.availablePrizes) {
      if (prize && prize.id != null) {
        prizeById.set(prize.id, prize);
      }
    }
  }

  const dynamicPrices = Array.isArray(doc.dynamicPrices) ? doc.dynamicPrices : [];

  const sortedGroups = Object.entries(groupMap).sort(
    ([a], [b]) => Number(a) - Number(b)
  );

  const clusters = sortedGroups.map(([group, prizeIds], index) => {
    const ids = Array.isArray(prizeIds) ? prizeIds : [prizeIds];
    const prizes = [];
    for (const prizeId of ids) {
      const prize = prizeById.get(prizeId);
      if (!prize) {
        log(`manager: prize id ${prizeId} (group ${group}) not found in either catalog`);
        continue;
      }
      prizes.push({
        prizeId,
        iconUrl: prize.iconUrl || null,
        amount: computePrizeAmount(prize),
      });
    }

    let enpItems = [];
    const dynamicPriceEntry = dynamicPrices[index];
    if (typeof dynamicPriceEntry === 'string') {
      let icons = ENP_ICON_URLS;
      if (doc.type === 'boxTokensMultiple') icons = [ENP_TOKENS_ICON_URL];
      else if (doc.type === 'gcMultiple') icons = [ENP_ICON_URLS[0]];
      enpItems = icons.map((iconUrl) => ({ iconUrl, text: dynamicPriceEntry }));
    }

    return { group, prizes, enpItems };
  });

  // Pairing above relies on ascending order (dynamicPrices[i] <-> the i-th
  // group ascending), but the team wants the highest tier displayed first —
  // so reverse only the final display order, after pairing is already done.
  return clusters.reverse().filter((c) => c.prizes.length > 0 || c.enpItems.length > 0);
}

function describeShape(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null || value === undefined) return 'missing';
  return typeof value;
}

app.get('/api/debug', requireAuth, requireDb, async (req, res) => {
  const db = req.db;
  log('debug: request received');
  const start = Date.now();
  try {
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map((c) => c.name);
    const hasCollection = collectionNames.includes('managers');

    let totalDocs = null;
    let popupDocs = null;
    let sampleManagerEntries = [];

    if (hasCollection) {
      const coll = db.collection('managers');
      totalDocs = await coll.countDocuments({}, { maxTimeMS: DEBUG_QUERY_MAX_TIME_MS });
      popupDocs = await coll.countDocuments(
        { _id: { $regex: '^popup:' } },
        { maxTimeMS: DEBUG_QUERY_MAX_TIME_MS }
      );

      const docs = await coll
        .find({ _id: { $regex: '^popup:' } })
        .limit(10)
        .maxTimeMS(DEBUG_QUERY_MAX_TIME_MS)
        .toArray();

      sampleManagerEntries = docs.map((item) => ({
        _id: String(item._id),
        topLevelKeys: Object.keys(item),
        designListShape: describeShape(item.designList),
      }));
    }

    log(`debug: success (${Date.now() - start}ms)`);
    res.json({
      dbName: db.databaseName,
      collectionNames,
      hasCollection,
      totalDocs,
      popupDocs,
      sampleManagerEntries,
    });
  } catch (err) {
    log(`debug: failed after ${Date.now() - start}ms —`, err.message);
    res.status(500).json({ error: 'Debug query failed.' });
  }
});

app.get('/api/images', requireAuth, requireDb, async (req, res) => {
  const db = req.db;
  log('images: query started');
  const start = Date.now();
  try {
    const asArray = (fieldPath) => ({
      $cond: [
        { $isArray: fieldPath },
        fieldPath,
        { $cond: [{ $eq: [{ $ifNull: [fieldPath, null] }, null] }, [], [fieldPath]] },
      ],
    });

    const rows = await db
      .collection('managers')
      .aggregate(
        [
          { $match: { _id: { $regex: '^popup:' } } },
          {
            $addFields: {
              _floorMatch: {
                $regexFind: { input: '$_id', regex: '^popup:(\\d+)' },
              },
            },
          },
          {
            $addFields: {
              _floorNumber: {
                $cond: [
                  { $ne: ['$_floorMatch', null] },
                  {
                    $convert: {
                      input: { $arrayElemAt: ['$_floorMatch.captures', 0] },
                      to: 'long',
                      onError: null,
                      onNull: null,
                    },
                  },
                  null,
                ],
              },
            },
          },
          {
            $match: {
              $or: [
                { _floorNumber: null },
                { _floorNumber: { $gte: MIN_FLOOR_NUMBER } },
              ],
            },
          },
          {
            $addFields: {
              _dynamicPricesArr: {
                $cond: [{ $isArray: '$dynamicPrices' }, '$dynamicPrices', []],
              },
            },
          },
          {
            $addFields: {
              _poCount: { $size: '$_dynamicPricesArr' },
            },
          },
          {
            $addFields: {
              poTier: {
                $cond: [
                  { $and: [{ $gte: ['$_poCount', 1] }, { $lte: ['$_poCount', 3] }] },
                  '$_poCount',
                  null,
                ],
              },
            },
          },
          {
            $addFields: {
              saleCategory: {
                $switch: {
                  branches: [
                    { case: { $in: ['$saleType', STATIC_SALE_TYPES] }, then: 'static' },
                    { case: { $in: ['$saleType', DYNAMIC_SALE_TYPES] }, then: 'dynamic' },
                  ],
                  default: null,
                },
              },
            },
          },
          {
            $addFields: {
              _topLevelImageItems: {
                $cond: [
                  { $ne: [{ $ifNull: ['$image.src', null] }, null] },
                  [{ image: '$image' }],
                  [],
                ],
              },
            },
          },
          {
            $addFields: {
              designItems: { $concatArrays: [asArray('$designList'), '$_topLevelImageItems'] },
            },
          },
          { $unwind: '$designItems' },
          { $match: { 'designItems.image.src': { $exists: true, $ne: null } } },
          {
            $project: {
              _id: 0,
              docId: '$_id',
              src: '$designItems.image.src',
              poTier: 1,
              saleCategory: 1,
              popupType: '$type',
              monitorSalesType: '$monitor.salesType',
            },
          },
          { $sort: { docId: 1 } },
          { $limit: RESULT_CAP + 1 },
        ],
        { maxTimeMS: IMAGES_QUERY_MAX_TIME_MS }
      )
      .toArray();

    const truncated = rows.length > RESULT_CAP;
    const results = (truncated ? rows.slice(0, RESULT_CAP) : rows).map((r) => ({
      id: String(r.docId),
      key: String(r.docId),
      src: r.src,
      poTier: r.poTier ?? null,
      saleCategory: r.saleCategory ?? null,
      popupType: r.popupType ?? null,
      monitorSalesType: r.monitorSalesType ?? null,
    }));

    log(`images: query finished — ${results.length} rows${truncated ? ' (truncated)' : ''} (${Date.now() - start}ms)`);
    res.json({ results, truncated });
  } catch (err) {
    log(`images: query failed after ${Date.now() - start}ms —`, err.message);
    if (err.codeName === 'MaxTimeMSExpired' || err.code === 50) {
      return res.status(504).json({
        error: `Query timed out after ${IMAGES_QUERY_MAX_TIME_MS / 1000}s. Check the server terminal for details.`,
      });
    }
    res.status(500).json({ error: 'Query failed. Check the server terminal for details.' });
  }
});

app.get('/api/next-available-id', requireAuth, requireDb, async (req, res) => {
  const db = req.db;
  log('next-available-id: request received');
  const start = Date.now();
  try {
    const docs = await db
      .collection('managers')
      .find({}, { projection: { _id: 1 }, maxTimeMS: DEBUG_QUERY_MAX_TIME_MS })
      .toArray();
    const ids = docs.map((doc) => String(doc._id));
    const availability = computeAvailability(ids, { limit: 5 });

    log(`next-available-id: success — next=${availability.next} (${Date.now() - start}ms)`);
    res.json(availability);
  } catch (err) {
    log(`next-available-id: failed after ${Date.now() - start}ms —`, err.message);
    res.status(500).json({ error: 'Query failed. Check the server terminal for details.' });
  }
});

app.get('/api/manager/:id', requireAuth, requireDb, async (req, res) => {
  const db = req.db;
  log(`manager: fetching _id=${req.params.id}`);
  const start = Date.now();
  try {
    const doc = await db
      .collection('managers')
      .findOne({ _id: req.params.id }, { maxTimeMS: DEBUG_QUERY_MAX_TIME_MS });

    log(`manager: ${doc ? 'found' : 'not found'} (${Date.now() - start}ms)`);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    const resolvedPrizes = await resolveAvailablePrizes(db, doc);
    res.json({ doc, resolvedPrizes });
  } catch (err) {
    log(`manager: failed after ${Date.now() - start}ms —`, err.message);
    res.status(500).json({ error: 'Failed to fetch document.' });
  }
});

app.get('/api/explain/:id', requireAuth, requireDb, async (req, res) => {
  const db = req.db;
  const id = req.params.id;
  log(`explain: checking _id=${id}`);
  const start = Date.now();
  try {
    const doc = await db
      .collection('managers')
      .findOne({ _id: id }, { maxTimeMS: DEBUG_QUERY_MAX_TIME_MS });

    if (!doc) {
      log(`explain: not found (${Date.now() - start}ms)`);
      return res.json({ found: false, id });
    }

    const matchesPopupPrefix = /^popup:/.test(id);

    const floorMatch = id.match(/^popup:(\d+)/);
    let floorNumber = null;
    let floorPasses = true;
    if (floorMatch) {
      try {
        floorNumber = BigInt(floorMatch[1]);
        floorPasses = floorNumber >= BigInt(MIN_FLOOR_NUMBER);
      } catch {
        floorNumber = null;
        floorPasses = true;
      }
    }

    const designListArr = Array.isArray(doc.designList)
      ? doc.designList
      : doc.designList
      ? [doc.designList]
      : [];
    const topLevelImageItem = doc.image && doc.image.src ? [{ image: doc.image }] : [];
    const allDesignItems = [...designListArr, ...topLevelImageItem];
    const srcs = allDesignItems
      .map((d) => d && d.image && d.image.src)
      .filter((s) => s != null);

    const dynamicPricesArr = Array.isArray(doc.dynamicPrices) ? doc.dynamicPrices : [];
    const poTier =
      dynamicPricesArr.length >= 1 && dynamicPricesArr.length <= 3
        ? dynamicPricesArr.length
        : null;

    let saleCategory = null;
    if (STATIC_SALE_TYPES.includes(doc.saleType)) saleCategory = 'static';
    else if (DYNAMIC_SALE_TYPES.includes(doc.saleType)) saleCategory = 'dynamic';

    const srcCollisions = [];
    for (const src of srcs) {
      const owners = await db
        .collection('managers')
        .find({
          _id: { $regex: '^popup:' },
          $or: [{ 'designList.image.src': src }, { 'image.src': src }],
        })
        .project({ _id: 1 })
        .maxTimeMS(DEBUG_QUERY_MAX_TIME_MS)
        .toArray();
      const ownerIds = Array.from(new Set(owners.map((o) => String(o._id)))).sort();
      srcCollisions.push({
        src,
        totalOwners: ownerIds.length,
        sharedWithOtherDocs: ownerIds.filter((oid) => oid !== id),
        winningOwner: ownerIds[0] || null,
      });
    }

    log(`explain: success (${Date.now() - start}ms)`);
    res.json({
      found: true,
      id,
      matchesPopupPrefix,
      floorNumber: floorNumber != null ? floorNumber.toString() : null,
      floorPasses,
      designListShape: describeShape(doc.designList),
      hasTopLevelImage: topLevelImageItem.length > 0,
      srcs,
      poTier,
      saleCategory,
      srcCollisions,
    });
  } catch (err) {
    log(`explain: failed after ${Date.now() - start}ms —`, err.message);
    res.status(500).json({ error: 'Explain query failed.' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(
    `Popup image browser running at http://${HOST}:${PORT} (auth ${AUTH_ENABLED ? 'enabled' : 'disabled'})`
  );
});
