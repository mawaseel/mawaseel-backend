import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import admin from 'firebase-admin';

const PORT = Number(process.env.PORT || 8787);
const PRIMARY_ADMIN_EMAIL = String(process.env.PRIMARY_ADMIN_EMAIL || 'mw.gl3tvl71en6c@mawaseel.ps').toLowerCase();
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || 'https://admin.mawaseel.ps,http://127.0.0.1:5502,http://localhost:5502,http://127.0.0.1:5500,http://localhost:5500')
  .split(',').map(x => x.trim()).filter(Boolean);

function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(raw);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return;
  }
  // Works automatically on Google Cloud / Cloud Run when Application Default Credentials are available.
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}

initFirebaseAdmin();
const db = admin.firestore();
const auth = admin.auth();
const app = express();

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '200kb' }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

function isPrimaryIdentity(decoded, userData = {}) {
  return String(decoded.email || '').toLowerCase() === PRIMARY_ADMIN_EMAIL || userData.isPrimaryAdmin === true;
}

async function requireAdmin(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ ok: false, error: 'missing_token' });

    const decoded = await auth.verifyIdToken(match[1], true);
    const snap = await db.doc(`users/${decoded.uid}`).get();
    const userData = snap.exists ? snap.data() : {};
    const isAdmin = userData?.active !== false && (userData?.role === 'admin' || userData?.isAdmin === true);
    if (!isAdmin) return res.status(403).json({ ok: false, error: 'admin_required' });

    req.adminUser = decoded;
    req.adminData = userData || {};
    req.isPrimaryAdmin = isPrimaryIdentity(decoded, userData || {});
    next();
  } catch (error) {
    console.error('Auth middleware:', error);
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

function requireManageAdmins(req, res, next) {
  if (req.isPrimaryAdmin || req.adminData?.permissions?.manageAdmins === true) return next();
  return res.status(403).json({ ok: false, error: 'manage_admins_required' });
}

function requirePrimary(req, res, next) {
  if (req.isPrimaryAdmin) return next();
  return res.status(403).json({ ok: false, error: 'primary_admin_required' });
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'mawaseel-admin-api' }));
app.get('/api/me', requireAdmin, (req, res) => res.json({
  ok: true,
  uid: req.adminUser.uid,
  email: req.adminUser.email || null,
  primary: req.isPrimaryAdmin,
  permissions: req.adminData.permissions || {}
}));

app.post('/api/admins', requireAdmin, requireManageAdmins, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const permissions = {
    ordersCreate: req.body?.permissions?.ordersCreate === true,
    ordersEdit: req.body?.permissions?.ordersEdit === true,
    ordersDelete: req.body?.permissions?.ordersDelete === true,
    manageAdmins: req.body?.permissions?.manageAdmins === true
  };

  if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
  if (!/^[a-z0-9._-]{4,32}$/.test(username)) return res.status(400).json({ ok: false, error: 'invalid_username' });
  if (password.length < 12) return res.status(400).json({ ok: false, error: 'weak_password' });

  const email = `${username}@admin.mawaseel.ps`;
  let createdUser = null;
  try {
    createdUser = await auth.createUser({ email, password, displayName: name, emailVerified: false, disabled: false });
    await db.doc(`users/${createdUser.uid}`).set({
      role: 'admin',
      isAdmin: true,
      active: true,
      adminName: name,
      adminUsername: username,
      email,
      permissions,
      isPrimaryAdmin: false,
      createdBy: req.adminUser.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(201).json({ ok: true, admin: { uid: createdUser.uid, name, username, email, permissions } });
  } catch (error) {
    console.error('Create admin:', error);
    if (createdUser?.uid) {
      try { await auth.deleteUser(createdUser.uid); } catch {}
    }
    if (error?.code === 'auth/email-already-exists') return res.status(409).json({ ok: false, error: 'username_exists' });
    return res.status(500).json({ ok: false, error: 'create_admin_failed' });
  }
});

app.delete('/api/admins/:uid', requireAdmin, requirePrimary, async (req, res) => {
  const uid = String(req.params.uid || '').trim();
  if (!uid) return res.status(400).json({ ok: false, error: 'uid_required' });
  if (uid === req.adminUser.uid) return res.status(400).json({ ok: false, error: 'cannot_delete_self' });

  try {
    const targetRef = db.doc(`users/${uid}`);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) return res.status(404).json({ ok: false, error: 'admin_not_found' });

    const targetData = targetSnap.data() || {};
    const isTargetAdmin = targetData.role === 'admin' || targetData.isAdmin === true;
    if (!isTargetAdmin) return res.status(400).json({ ok: false, error: 'target_not_admin' });

    let targetAuth = null;
    try { targetAuth = await auth.getUser(uid); } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }

    const targetEmail = String(targetAuth?.email || targetData.email || '').toLowerCase();
    if (targetData.isPrimaryAdmin === true || targetEmail === PRIMARY_ADMIN_EMAIL) {
      return res.status(403).json({ ok: false, error: 'cannot_delete_primary' });
    }

    if (targetAuth) await auth.deleteUser(uid);
    await targetRef.delete();

    return res.json({ ok: true, deletedUid: uid });
  } catch (error) {
    console.error('Delete admin:', error);
    return res.status(500).json({ ok: false, error: 'delete_admin_failed' });
  }
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled middleware error:', err);
  res.status(500).json({ ok: false, error: 'server_error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mawaseel Admin API listening on port ${PORT}`);
});
