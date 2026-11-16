# الدومين الدائم — Clinical Audit Syria

المنصة تعمل حالياً على HTTPS عبر نفق Cloudflare. للحصول على **دومين دائم ثابت** باسم يحتوي
«Clinical Audit Syria» هناك مسارَان. كلاهما يحتاج **تسجيل دخول واحد فقط** منك (Google/GitHub أو Cloudflare)
لأن ملكية الدومين/الحساب لا يمكن أن تتم آلياً من داخل بيئة المعالجة.

---

## المسار (أ) — الأسرع: دومين مجاني ثابت `clinical-audit-syria.serveo.net`

لا يحتاج شراء دومين. يكفي تسجيل مفتاح SSH مرة واحدة.

1. افتح رابط تسجيل المفتاح (سجّل الدخول بـ Google أو GitHub):
   `https://console.serveo.net/ssh/keys?add=SHA256%3At%2BigNK6wWBZWcqKnPHWDVUWXR2ijFmFt6Izdeo04TcY`
2. بعد التسجيل، شغّل على الخادم:
   ```bash
   bash deploy/setup-serveo.sh
   ```
   سيُفتح الرابط الثابت: **https://clinical-audit-syria.serveo.net**
3. حدّث `PUBLIC_URL` في `.env` إلى هذا الرابط ثم أعد تشغيل الخدمة.

> ملاحظة: النسخة المجانية من Serveo تعرض صفحة تحذير أولية للزائر. لإزالتها يلزم اشتراك Pro،
> أو استخدم المسار (ب) للحصول على دومين نظيف تماماً.

---

## المسار (ب) — الاحترافي: دومين تملكه + Cloudflare Tunnel

يتطلب أن يكون لديك دومين (مثلاً `clinicalaudit-syria.org`) مضاف إلى حساب Cloudflare مجاني.

1. ثبّت cloudflared (موجود في البيئة) وسجّل الدخول مرة واحدة:
   ```bash
   cloudflared tunnel login          # يفتح المتصفح لاختيار الدومين
   ```
2. أنشئ النفق واربطه بالدومين:
   ```bash
   bash deploy/setup-cloudflare-tunnel.sh clinicalaudit-syria.org app.clinicalaudit-syria.org
   ```
   السكربت ينشئ النفق `clinical-audit-syria`، يضيف سجل CNAME، ويشغّل الخدمة كـ systemd.
3. حدّث `PUBLIC_URL=https://app.clinicalaudit-syria.org` في `.env`.

### إضافة redirect URI في Google (مطلوب لربط Drive)
في Google Cloud Console ← APIs & Services ← Credentials ← عميل OAuth (نوع **Web application**)
← Authorized redirect URIs أضف:
```
https://<دومينك>/api/drive/oauth/callback
```
ثم من داخل المنصة (الدليل والمصطلحات ← بطاقة «ربط Google Drive») اضغط **«ربط الحساب الآن»**
وسجّل الدخول بحساب `ClinicalAudit.Syria@gmail.com` ووافق. سيُحفظ رمز التحديث تلقائياً.

---

## المسار (ج) — خادم VPS بدومين + شهادة Let's Encrypt

إذا كان لديك خادم عام (Ubuntu/Debian) ودومين يشير إلى عنوانه:

```bash
bash deploy/setup-vps.sh app.clinicalaudit-syria.org you@email.com
```
السكربت: ينسخ التطبيق إلى `/opt/clinicalaudit-syria`، يثبّت Node، يضبط nginx،
يصدر شهادة certbot تلقائياً، ويشغّل خدمة systemd مع إعادة التشغيل التلقائي.

---

## بعد تثبيت الدومين
- `PUBLIC_URL` في `.env` = رابط الدومين.
- أضف نفس رابط الـ callback في Google Cloud (أعلاه).
- جرّب: `curl -I https://<دومينك>/` يجب أن يعيد 200 مع HSTS.
