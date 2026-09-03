# Mawaseel Admin Backend

Backend آمن لإدارة حسابات الأدمنز باستخدام Firebase Admin SDK.

## ماذا يفعل؟
- يتحقق من Firebase ID Token القادم من موقع الأدمن.
- يسمح بإنشاء أدمن جديد فقط لمن لديه `manageAdmins` أو للحساب الأساسي.
- يسمح بحذف أدمن من **Firebase Authentication + Firestore** للحساب الأساسي فقط.
- يمنع حذف الحساب الأساسي أو حذف الحساب الحالي لنفسه.
- لا يحفظ Service Account أو كلمات السر داخل ملفات HTML.

## تشغيل محلي
1. انسخ `.env.example` إلى `.env`.
2. ضع `FIREBASE_SERVICE_ACCOUNT_JSON` الحقيقي داخل `.env`.
3. شغل:
   ```bash
   npm install
   npm start
   ```
4. الـAPI يعمل افتراضيًا على `http://127.0.0.1:8787`.

## الحصول على Service Account
Firebase Console / Google Cloud Console > Project Settings > Service Accounts > Generate new private key.
ضع JSON داخل متغير البيئة فقط. **لا ترفعه مع الموقع ولا GitHub.**

## النشر
يمكن نشر مجلد `backend` على Render أو Railway أو Cloud Run.
للإنتاج يفضل ربطه بدومين:
`https://api.mawaseel.ps`

على Render:
- ارفع مجلد backend إلى مستودع خاص.
- Build Command: `npm install`
- Start Command: `npm start`
- أضف Environment Variables من `.env.example`.
- بعد النشر اربط `api.mawaseel.ps` بالخدمة.

## ملاحظة
موقع الأدمن مبرمج تلقائيًا لاستخدام:
- Local: `http://127.0.0.1:8787`
- Production: `https://api.mawaseel.ps`
