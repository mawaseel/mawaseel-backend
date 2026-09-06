import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import admin from 'firebase-admin';

const PORT = Number(process.env.PORT || 8787);
const PRIMARY_ADMIN_EMAIL = String(process.env.PRIMARY_ADMIN_EMAIL || 'mw.gl3tvl71en6c@mawaseel.ps').toLowerCase();
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || 'https://mawaseel.github.io,https://admin.mawaseel.ps,https://dashboard.mawaseel.ps,http://127.0.0.1:5502,http://localhost:5502,http://127.0.0.1:5500,http://localhost:5500')
  .split(',').map(x => x.trim()).filter(Boolean);

function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    let serviceAccount;
    try { serviceAccount = JSON.parse(raw); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return;
  }
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
initFirebaseAdmin();

const db = admin.firestore();
const auth = admin.auth();
const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '300kb' }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const round2 = n => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const nowTs = () => admin.firestore.Timestamp.now();
function normalizePhone(value) {
  let s = String(value || '').trim().replace(/[^0-9+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  let digits = s.replace(/\D/g, '');
  if (digits.startsWith('0') && /^0(5|4)/.test(digits)) return null; // نطلب مقدمة الدولة لتفادي تكرار نفس الرقم بصيغ مختلفة.
  if (!/^(970|972)\d{8,12}$/.test(digits)) return null;
  return '+' + digits;
}
function customerKey(phone) { return crypto.createHash('sha256').update(phone).digest('hex'); }
function normalizeLegacyPhone(value) {
  const direct = normalizePhone(value); if (direct) return direct;
  const d = String(value || '').replace(/\D/g, '');
  if (/^0(59|56)\d{7}$/.test(d)) return '+970' + d.slice(1);
  if (/^0(50|52|53|54|55|58)\d{7}$/.test(d)) return '+972' + d.slice(1);
  return null;
}
function financials(batchTotal, orderAmount, profitRatePct) {
  const bt = Number(batchTotal), oa = Number(orderAmount), pr = Number(profitRatePct);
  if (!(bt > 0) || !(oa > 0) || oa > bt || !(pr >= 0 && pr <= 100)) return null;
  const batchProfit = round2(bt * pr / 100);
  const orderProfit = round2(oa * pr / 100);
  return { batchTotal: round2(bt), orderAmount: round2(oa), profitRatePct: round2(pr), batchProfit, orderProfit };
}
function orderNumber(id) {
  return 'MW-' + new Date().toISOString().slice(2, 10).replaceAll('-', '') + '-' + id.slice(0, 4).toUpperCase();
}
function isPrimaryIdentity(decoded, userData = {}) {
  return String(decoded.email || '').toLowerCase() === PRIMARY_ADMIN_EMAIL || userData.isPrimaryAdmin === true;
}

async function loadIdentity(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error('missing_token'), { status: 401, code: 'missing_token' });
  const decoded = await auth.verifyIdToken(match[1], true);
  const snap = await db.doc(`users/${decoded.uid}`).get();
  return { decoded, snap, data: snap.exists ? snap.data() : {} };
}
async function requireAdmin(req, res, next) {
  try {
    const { decoded, data } = await loadIdentity(req);
    const ok = data?.active !== false && (data?.role === 'admin' || data?.isAdmin === true);
    if (!ok) return res.status(403).json({ ok: false, error: 'admin_required' });
    req.adminUser = decoded; req.adminData = data || {}; req.isPrimaryAdmin = isPrimaryIdentity(decoded, data || {}); next();
  } catch (e) { console.error('Admin auth:', e); return res.status(e.status || 401).json({ ok: false, error: e.code || 'invalid_token' }); }
}
const requirePermission = name => (req, res, next) => {
  if (req.isPrimaryAdmin || req.adminData?.permissions?.[name] === true) return next();
  return res.status(403).json({ ok: false, error: `${name}_required` });
};
function requirePrimary(req, res, next) { if (req.isPrimaryAdmin) return next(); return res.status(403).json({ ok: false, error: 'primary_admin_required' }); }

app.get('/', (_req, res) => res.json({ ok: true, service: 'mawaseel-admin-api', version: '4-commission' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'mawaseel-admin-api', version: '4-commission' }));
app.get('/api/me', requireAdmin, (req, res) => res.json({ ok: true, uid: req.adminUser.uid, email: req.adminUser.email || null, primary: req.isPrimaryAdmin, permissions: req.adminData.permissions || {} }));

app.post('/api/admins', requireAdmin, requirePermission('manageAdmins'), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const permissions = {
    ordersCreate: req.body?.permissions?.ordersCreate === true,
    ordersEdit: req.body?.permissions?.ordersEdit === true,
    ordersDelete: req.body?.permissions?.ordersDelete === true,
    manageAdmins: req.body?.permissions?.manageAdmins === true,
    manageVerifications: req.body?.permissions?.manageVerifications === true,
    approveMarketers: req.body?.permissions?.approveMarketers === true
  };
  if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
  if (!/^[a-z0-9._-]{4,32}$/.test(username)) return res.status(400).json({ ok: false, error: 'invalid_username' });
  if (password.length < 12) return res.status(400).json({ ok: false, error: 'weak_password' });
  const email = `${username}@admin.mawaseel.ps`;
  let createdUser = null;
  try {
    createdUser = await auth.createUser({ email, password, displayName: name, disabled: false });
    await db.doc(`users/${createdUser.uid}`).set({ role: 'admin', isAdmin: true, active: true, adminName: name, adminUsername: username, email, permissions, isPrimaryAdmin: false, createdBy: req.adminUser.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.status(201).json({ ok: true, admin: { uid: createdUser.uid, name, username, email, permissions } });
  } catch (error) {
    console.error('Create admin:', error);
    if (createdUser?.uid) try { await auth.deleteUser(createdUser.uid); } catch {}
    if (error?.code === 'auth/email-already-exists') return res.status(409).json({ ok: false, error: 'username_exists' });
    return res.status(500).json({ ok: false, error: 'create_admin_failed' });
  }
});

app.post('/api/verifications/:uid/approve', requireAdmin, requirePermission('manageVerifications'), async (req, res) => {
  const uid = String(req.params.uid || '').trim();
  if (!uid) return res.status(400).json({ ok: false, error: 'uid_required' });
  try {
    const userRef = db.doc(`users/${uid}`), requestRef = db.doc(`verificationRequests/${uid}`), userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const now = nowTs(), end = admin.firestore.Timestamp.fromMillis(now.toMillis() + 2 * 24 * 60 * 60 * 1000), batch = db.batch();
    batch.set(userRef, { verificationStatus: 'approved', verifiedAt: now, verifiedBy: req.adminUser.uid, trialStatus: 'active', trialStartedAt: now, trialEndsAt: end, marketerStatus: 'trial', marketerApplicationStatus: 'pending' }, { merge: true });
    batch.set(requestRef, { status: 'approved', reviewedAt: now, reviewedBy: req.adminUser.uid }, { merge: true });
    await batch.commit(); return res.json({ ok: true, uid, trialEndsAt: end.toDate().toISOString() });
  } catch (e) { console.error(e); return res.status(500).json({ ok: false, error: 'approve_verification_failed' }); }
});
app.post('/api/verifications/:uid/reject', requireAdmin, requirePermission('manageVerifications'), async (req, res) => {
  const uid = String(req.params.uid || '').trim(); if (!uid) return res.status(400).json({ ok: false, error: 'uid_required' });
  try { const now = nowTs(), batch = db.batch(); batch.set(db.doc(`users/${uid}`), { verificationStatus: 'rejected', verificationRejectedAt: now, verificationReviewedBy: req.adminUser.uid }, { merge: true }); batch.set(db.doc(`verificationRequests/${uid}`), { status: 'rejected', reviewedAt: now, reviewedBy: req.adminUser.uid }, { merge: true }); await batch.commit(); return res.json({ ok: true, uid }); }
  catch (e) { console.error(e); return res.status(500).json({ ok: false, error: 'reject_verification_failed' }); }
});
app.post('/api/partners/:uid/approve-marketer', requireAdmin, requirePermission('approveMarketers'), async (req, res) => {
  const uid = String(req.params.uid || '').trim(); if (!uid) return res.status(400).json({ ok: false, error: 'uid_required' });
  try { const ref = db.doc(`users/${uid}`), snap = await ref.get(); if (!snap.exists) return res.status(404).json({ ok: false, error: 'user_not_found' }); const data = snap.data() || {}; if (data.verificationStatus !== 'approved') return res.status(400).json({ ok: false, error: 'verification_required' }); const now = nowTs(); await ref.set({ marketerStatus: 'approved', marketerApplicationStatus: 'approved', marketerApprovedAt: now, marketerApprovedBy: req.adminUser.uid, trialStatus: 'approved' }, { merge: true }); return res.json({ ok: true, uid }); }
  catch (e) { console.error(e); return res.status(500).json({ ok: false, error: 'approve_marketer_failed' }); }
});

app.get('/api/customers/lookup', requireAdmin, requirePermission('ordersCreate'), async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  try {
    const id = customerKey(phone), snap = await db.doc(`customers/${id}`).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'customer_not_found' });
    const c = snap.data() || {}, pSnap = await db.doc(`users/${c.partnerId}`).get(), p = pSnap.exists ? pSnap.data() : {};
    return res.json({ ok: true, customer: { id, phone: c.phoneDisplay || phone, customerName: c.customerName || '', customerLocation: c.customerLocation || '', partnerId: c.partnerId, partnerName: [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || 'مسوق', partnerCode: p.partnerCode || '', orderCount: Number(c.orderCount || 0), showPhoneToPartner: c.showPhoneToPartner === true } });
  } catch (e) { console.error(e); return res.status(500).json({ ok: false, error: 'lookup_failed' }); }
});

async function getPartnerForOrder(partnerId) {
  const ref = db.doc(`users/${partnerId}`), snap = await ref.get();
  if (!snap.exists) return null;
  const p = snap.data() || {};
  if (p.verificationStatus !== 'approved') return null;
  return { ref, data: p };
}

app.post('/api/orders/first', requireAdmin, requirePermission('ordersCreate'), async (req, res) => {
  const partnerId = String(req.body?.partnerId || '').trim();
  const phone = normalizePhone(req.body?.customerPhone);
  const f = financials(req.body?.batchTotal, req.body?.orderAmount, req.body?.profitRatePct);
  if (!partnerId) return res.status(400).json({ ok: false, error: 'partner_required' });
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  if (!f) return res.status(400).json({ ok: false, error: 'invalid_financials' });
  const partner = await getPartnerForOrder(partnerId);
  if (!partner) return res.status(400).json({ ok: false, error: 'partner_not_verified' });
  const customerId = customerKey(phone), customerRef = db.doc(`customers/${customerId}`), orderRef = db.collection('orders').doc();
  const trial = partner.data.marketerStatus !== 'approved';
  const rate = trial ? 0 : 50, commission = round2(f.orderProfit * rate / 100), showPhone = req.body?.showCustomerPhone === true, now = nowTs();
  const customerName = String(req.body?.customerName || '').trim(), customerLocation = String(req.body?.customerLocation || '').trim();
  if (!customerName || !customerLocation) return res.status(400).json({ ok: false, error: 'customer_details_required' });
  const status = String(req.body?.status || 'new'), store = String(req.body?.store || 'shein').toLowerCase();
  try {
    await db.runTransaction(async tx => {
      const cSnap = await tx.get(customerRef);
      if (cSnap.exists) { const err = new Error('customer_already_registered'); err.code = 'customer_already_registered'; err.ownerPartnerId = cSnap.data()?.partnerId; throw err; }
      tx.set(customerRef, { phoneNormalized: phone, phoneDisplay: phone, partnerId, customerName, customerLocation, showPhoneToPartner: showPhone, firstOrderId: orderRef.id, orderCount: 1, createdAt: now, updatedAt: now, lastOrderAt: now, createdBy: req.adminUser.uid });
      tx.set(orderRef, { partnerId, customerId, customerName, customerLocation, customerPhonePublic: showPhone ? phone : null, showCustomerPhone: showPhone, store, isTrialOrder: trial, trialNoEarnings: trial, ...f, commissionRate: rate, partnerCommission: commission, commissionType: trial ? 'trial' : 'first', customerOrderIndex: 1, isInvestment: false, notes: String(req.body?.notes || '').trim(), status, createdBy: req.adminUser.uid, createdAt: now, updatedAt: now, orderNumber: orderNumber(orderRef.id), statusHistory: [{ status, at: now, by: req.adminUser.uid }] });
    });
    return res.status(201).json({ ok: true, orderId: orderRef.id, orderNumber: orderNumber(orderRef.id), commissionRate: rate, partnerCommission: commission, orderProfit: f.orderProfit, trial });
  } catch (e) {
    if (e.code === 'customer_already_registered') return res.status(409).json({ ok: false, error: 'customer_already_registered', ownerPartnerId: e.ownerPartnerId || null });
    console.error('Create first order:', e); return res.status(500).json({ ok: false, error: 'create_order_failed' });
  }
});

app.post('/api/orders/investment', requireAdmin, requirePermission('ordersCreate'), async (req, res) => {
  const phone = normalizePhone(req.body?.customerPhone), f = financials(req.body?.batchTotal, req.body?.orderAmount, req.body?.profitRatePct);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  if (!f) return res.status(400).json({ ok: false, error: 'invalid_financials' });
  const customerId = customerKey(phone), customerRef = db.doc(`customers/${customerId}`), orderRef = db.collection('orders').doc(), now = nowTs();
  try {
    const cSnap = await customerRef.get(); if (!cSnap.exists) return res.status(404).json({ ok: false, error: 'customer_not_found' });
    const c = cSnap.data() || {}, partner = await getPartnerForOrder(c.partnerId); if (!partner) return res.status(400).json({ ok: false, error: 'partner_not_verified' });
    const trial = partner.data.marketerStatus !== 'approved', rate = trial ? 0 : 20, commission = round2(f.orderProfit * rate / 100), showPhone = req.body?.showCustomerPhone ?? c.showPhoneToPartner === true;
    const customerName = String(req.body?.customerName || c.customerName || '').trim(), customerLocation = String(req.body?.customerLocation || c.customerLocation || '').trim();
    const status = String(req.body?.status || 'new'), store = String(req.body?.store || 'shein').toLowerCase();
    await db.runTransaction(async tx => {
      const fresh = await tx.get(customerRef); if (!fresh.exists) throw Object.assign(new Error('customer_not_found'), { code: 'customer_not_found' }); const data = fresh.data() || {}; const index = Number(data.orderCount || 0) + 1;
      tx.set(customerRef, { customerName, customerLocation, showPhoneToPartner: showPhone === true, orderCount: index, updatedAt: now, lastOrderAt: now }, { merge: true });
      tx.set(orderRef, { partnerId: data.partnerId, customerId, customerName, customerLocation, customerPhonePublic: showPhone === true ? phone : null, showCustomerPhone: showPhone === true, store, isTrialOrder: trial, trialNoEarnings: trial, ...f, commissionRate: rate, partnerCommission: commission, commissionType: trial ? 'trial' : 'investment', customerOrderIndex: index, isInvestment: true, notes: String(req.body?.notes || '').trim(), status, createdBy: req.adminUser.uid, createdAt: now, updatedAt: now, orderNumber: orderNumber(orderRef.id), statusHistory: [{ status, at: now, by: req.adminUser.uid }] });
    });
    return res.status(201).json({ ok: true, orderId: orderRef.id, orderNumber: orderNumber(orderRef.id), partnerId: c.partnerId, commissionRate: rate, partnerCommission: commission, orderProfit: f.orderProfit, trial });
  } catch (e) { console.error('Investment order:', e); return res.status(e.code === 'customer_not_found' ? 404 : 500).json({ ok: false, error: e.code || 'create_investment_failed' }); }
});

app.patch('/api/orders/:id', requireAdmin, requirePermission('ordersEdit'), async (req, res) => {
  const id = String(req.params.id || '').trim(); if (!id) return res.status(400).json({ ok: false, error: 'order_required' });
  try {
    const ref = db.doc(`orders/${id}`), snap = await ref.get(); if (!snap.exists) return res.status(404).json({ ok: false, error: 'order_not_found' }); const o = snap.data() || {};
    const f = financials(req.body?.batchTotal ?? o.batchTotal, req.body?.orderAmount ?? o.orderAmount, req.body?.profitRatePct ?? o.profitRatePct); if (!f) return res.status(400).json({ ok: false, error: 'invalid_financials' });
    const rate = o.isTrialOrder === true ? 0 : (o.commissionType === 'investment' ? 20 : 50), commission = round2(f.orderProfit * rate / 100), newStatus = String(req.body?.status || o.status || 'new'), showPhone = req.body?.showCustomerPhone ?? o.showCustomerPhone === true;
    let actualPhone = o.customerPhonePublic || o.customerPhone || null;
    if (o.customerId) { const cSnap = await db.doc(`customers/${o.customerId}`).get(); if (cSnap.exists) actualPhone = cSnap.data()?.phoneDisplay || actualPhone; }
    const payload = { customerName: String(req.body?.customerName ?? o.customerName ?? '').trim(), customerLocation: String(req.body?.customerLocation ?? o.customerLocation ?? '').trim(), store: String(req.body?.store ?? o.store ?? 'shein').toLowerCase(), ...f, commissionRate: rate, partnerCommission: commission, customerPhonePublic: showPhone === true ? actualPhone : null, showCustomerPhone: showPhone === true, notes: String(req.body?.notes ?? o.notes ?? '').trim(), status: newStatus, updatedAt: nowTs(), lastEditedBy: req.adminUser.uid };
    if (o.status !== newStatus) payload.statusHistory = admin.firestore.FieldValue.arrayUnion({ status: newStatus, at: nowTs(), by: req.adminUser.uid });
    await ref.update(payload);
    if (o.customerId) await db.doc(`customers/${o.customerId}`).set({ customerName: payload.customerName, customerLocation: payload.customerLocation, showPhoneToPartner: showPhone === true, updatedAt: nowTs() }, { merge: true });
    return res.json({ ok: true, partnerCommission: commission, commissionRate: rate, orderProfit: f.orderProfit });
  } catch (e) { console.error('Edit order:', e); return res.status(500).json({ ok: false, error: 'edit_order_failed' }); }
});
app.delete('/api/orders/:id', requireAdmin, requirePermission('ordersDelete'), async (req, res) => {
  const id = String(req.params.id || '').trim(); if (!id) return res.status(400).json({ ok: false, error: 'order_required' });
  try { const ref = db.doc(`orders/${id}`), snap = await ref.get(); if (!snap.exists) return res.status(404).json({ ok: false, error: 'order_not_found' }); await ref.delete(); return res.json({ ok: true, deletedOrderId: id }); }
  catch (e) { console.error('Delete order:', e); return res.status(500).json({ ok: false, error: 'delete_order_failed' }); }
});


app.post('/api/maintenance/migrate-legacy-orders', requireAdmin, requirePrimary, async (req, res) => {
  try {
    const snap = await db.collection('orders').get();
    const rows = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
      .filter(o => !o.customerId && o.customerPhone && o.partnerId)
      .sort((a,b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
    let migrated = 0, skipped = 0, conflicts = 0;
    for (const o of rows) {
      const phone = normalizeLegacyPhone(o.customerPhone); if (!phone) { skipped++; continue; }
      const id = customerKey(phone), cRef = db.doc(`customers/${id}`), now = nowTs();
      await db.runTransaction(async tx => {
        const cSnap = await tx.get(cRef); let index = 1;
        if (cSnap.exists) {
          const c = cSnap.data() || {};
          if (c.partnerId && c.partnerId !== o.partnerId) {
            tx.update(o.ref, { customerOwnershipConflict: true, migrationCheckedAt: now }); conflicts++; return;
          }
          index = Number(c.orderCount || 0) + 1;
          tx.set(cRef, { orderCount: index, lastOrderAt: o.createdAt || now, updatedAt: now }, { merge: true });
        } else {
          tx.set(cRef, { phoneNormalized: phone, phoneDisplay: phone, partnerId: o.partnerId, customerName: o.customerName || '', customerLocation: o.customerLocation || '', showPhoneToPartner: o.showCustomerPhone === true, firstOrderId: o.id, orderCount: 1, createdAt: o.createdAt || now, updatedAt: now, lastOrderAt: o.createdAt || now, createdBy: req.adminUser.uid, migratedFromLegacy: true });
        }
        tx.update(o.ref, { customerId: id, customerPhonePublic: o.showCustomerPhone === true ? phone : null, customerPhone: admin.firestore.FieldValue.delete(), commissionType: 'legacy', customerOrderIndex: index, migratedAt: now });
        migrated++;
      });
    }
    return res.json({ ok: true, scanned: rows.length, migrated, skipped, conflicts });
  } catch (e) { console.error('Legacy migration:', e); return res.status(500).json({ ok: false, error: 'migration_failed' }); }
});

app.delete('/api/admins/:uid', requireAdmin, requirePrimary, async (req, res) => {
  const uid = String(req.params.uid || '').trim(); if (!uid) return res.status(400).json({ ok: false, error: 'uid_required' }); if (uid === req.adminUser.uid) return res.status(400).json({ ok: false, error: 'cannot_delete_self' });
  try {
    const targetRef = db.doc(`users/${uid}`), targetSnap = await targetRef.get(); if (!targetSnap.exists) return res.status(404).json({ ok: false, error: 'admin_not_found' }); const targetData = targetSnap.data() || {}; if (!(targetData.role === 'admin' || targetData.isAdmin === true)) return res.status(400).json({ ok: false, error: 'target_not_admin' });
    let targetAuth = null; try { targetAuth = await auth.getUser(uid); } catch (error) { if (error?.code !== 'auth/user-not-found') throw error; }
    const targetEmail = String(targetAuth?.email || targetData.email || '').toLowerCase(); if (targetData.isPrimaryAdmin === true || targetEmail === PRIMARY_ADMIN_EMAIL) return res.status(403).json({ ok: false, error: 'cannot_delete_primary' });
    if (targetAuth) await auth.deleteUser(uid); await targetRef.delete(); return res.json({ ok: true, deletedUid: uid });
  } catch (e) { console.error('Delete admin:', e); return res.status(500).json({ ok: false, error: 'delete_admin_failed' }); }
});

app.use((err, _req, res, _next) => { console.error('Unhandled middleware error:', err); res.status(500).json({ ok: false, error: 'server_error' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`Mawaseel Admin API listening on port ${PORT}`));
