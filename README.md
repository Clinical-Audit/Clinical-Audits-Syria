# Clinical Audit Syria — منصة التدقيق السريري (نسخة كاملة Full-stack)

## الإعداد الحالي (جاهز)
- **الحساب الوحيد:** `Ahmed Al-Beiruti` — `ahmedalbeiruti1@gmail.com` — كلمة المرور `2016` — الدور: **منشئ** (كل صلاحيات المنشئ).
- **كود الدعوة الصالح الوحيد:** `CA-SY-2026`.
- **Google Drive:** مسار OAuth2 (Client ID/Secret جاهزان في `oauth_token.json` و`.env.example`).
  رمز التحديث الحالي مرفوض من Google (`unauthorized_client`) لأنه صادر لعميل OAuth آخر؛
  أعد الربط بضغطة «ربط الحساب الآن» داخل المنصة بعد إضافة redirect URI في Google Cloud.
- **الدومين الدائم:** راجع `deploy/PERMANENT-DOMAIN.md` (Serveo مجاني ثابت أو Cloudflare Tunnel/دومين مملوك أو VPS).


منصة ويب عربية (RTL) لإدارة مشاريع التدقيق السريري لفريق **جامعة دمشق**، مبنية على خادم Node.js/Express
مع واجهة صفحة واحدة (SPA) بلا أي مكتبات خارجية، ومصادقة حقيقية، وصلاحيات مفروضة **على الخادم**،
وجلسات لها تاريخ انتهاء، ونسخ احتياطية مشفّرة، ومزامنة تلقائية لكل مستند إلى Google Drive.

---

## 1) ما الذي أُنجز

### الأمان والبنية الخلفية
| المتطلب | التنفيذ |
|---|---|
| HTTPS نظامي | خادم HTTPS مدمج (شهادة ذاتية للتطوير) + إعداد nginx + Let's Encrypt لدومين حقيقي (مجلد `deploy/`) |
| صلاحيات على الخادم لا في الواجهة فقط | `requireAuth` و`requireCreator` كوسائط Middleware على كل مسار حسّاس؛ الواجهة تُخفي الأزرار فقط، والخادم يرفض أي طلب غير مصرّح به بـ 401/403 |
| انتهاء جلسة | كوكي `ca_sid` من نوع httpOnly + Secure + SameSite=Lax، مع مدة مطلقة (8 ساعات) ومدة خمول (30 دقيقة)، وتجديد تلقائي، وإنهاء الجلسة من الخادم |
| تشفير النسخ الاحتياطية | AES-256-GCM، ملفات `.cab` بصيغة `CABK0001 | IV | TAG | CIPHERTEXT`، مفتاح في `backup.key`، نسخة كل 6 ساعات + نسخة عند الطلب، والاحتفاظ بآخر 60 نسخة |
| رفع كل مستند تلقائياً إلى Google Drive | كل رفع عبر `POST /api/projects/:id/attachments` يُخزَّن على الخادم **ثم يُرفع فوراً** إلى `ClinicalAudit.Syria@gmail.com / clinical audit data / <رمز المشروع>` بغض النظر عن أي خيار اختياري |
| سجل تدقيق | كل عملية (دخول، إنشاء/تعديل/إلغاء مشروع، رفع مستند، إضافة/إزالة عضو، تعديل فرق) تُسجَّل باسم المُنفِّذ وتاريخه |

### الواجهة (قائمة التعديلات الـ26)
1. النقر خارج القائمة الجانبية يغلقها.
2. رأس القائمة: «فريق التدقيق السريري» بخط كبير، وتحته «جامعة دمشق» بخط أصغر.
3. زر الرجوع في المتصفح/الهاتف يتنقّل داخل الموقع (Wizard ← المشاريع ← النظرة العامة) بدل الخروج.
4. «نظرة عامة» بدل «لوحة المؤشرات»، ومسار التنقّل «الرئيسية / نظرة عامة».
5. «جامعة دمشق — دمشق · N مشروعاً قيد العمل» بدل اسم المشفى.
6. «توزيع الحالات» بدل «توزيع الحالة».
7. حذف عبارة «محسوب من البسط ÷ المقام لكل معيار».
8. عمود «رقم الفريق» في جدول أحدث المشاريع.
9. بحث وترتيب في صفحة المشاريع حسب تاريخ البدء/درجة الإنجاز/نسبة الالتزام/رقم الفريق، تصاعدي وتنازلي.
10. عمود Google Drive فيه زرّان: «رفع تقرير المشروع إلى Google Drive» و«رفع مستندات المشروع إلى Google Drive».
11. صفحة المشروع الجديد تفتح القائمة الجانبية عند النقر (أُزيل قيد `no-sidebar`).
12. تبويب تعريف المشروع: رقم الفريق (001/002/003)، ورقم المشروع داخل الفريق، ورمز آلي للقراءة فقط بصيغة `CA-001-002`، وحذف التلميح «ثلاثة أرقام، مثال 001».
13. كل حقول الرفع أصبحت زراً منسّقاً بهوية الموقع باسم «رفع مستند».
14. نسبة الالتزام تُحسب فورياً أثناء الإدخال (لكل معيار وللمجموع).
15. تاريخ إعادة التقييم اختياري ولا يمنع الحفظ.
16. حذف عبارة «حساب Drive المعتمد…».
17. زر «رفع المستندات إلى Google Drive» لرفع كل مستندات المشروع دفعة واحدة.
18. تأكيد إلغاء المشروع داخل الموقع (Modal) بهوية الموقع، لا نافذة المتصفح.
19. صفحة الأعضاء: بطاقات أفقية (صورة أعلى، الاسم، البريد، رقم الفريق).
20. أسفلها الفرق الفرعية (رقم الفريق، القائد، الأعضاء) — الإنشاء/التعديل/الحذف لمنشئ الموقع فقط، والبقية للقراءة فقط.
21. إخراج أي مستخدم من الموقع وحذف عضويته وحسابه — لمنشئ الموقع فقط.
22. صفحة إنشاء الحساب تسمح برفع صورة شخصية تظهر أعلى الاسم في قائمة الأعضاء.
23. «إضافة عضو جديد» تضيف العضو إلى قائمة الأعضاء، ثم يوزّعه المنشئ على فريق فرعي.
24. الترتيب: إضافة عضو ← قائمة الأعضاء ← الفرق الفرعية.
25. سجل الأحداث يكتب اسم العضو الذي أجرى كل تغيير.
26. حُذف المشروعان الوهميان `aud-2026-001` و`aud-2026-002`.

---

## 2) التشغيل السريع

```bash
cd app
npm install --omit=dev
cp .env.example .env      # عدّل القيم
./start.sh
```

- HTTP: `http://localhost:8080`
- HTTPS: `https://localhost:8443` (شهادة ذاتية تُولَّد تلقائياً في `certs/`)

الحساب الأول (يُنشأ تلقائياً عند أول تشغيل):
- البريد: `ahmedalbeiruti1@gmail.com`
- كلمة المرور: `ClinicalAudit@2026`  ← **غيّرها بعد أول دخول**
- رمز الدعوة للتسجيل: `MWASAT-AUDIT-2026`

---

## 3) النشر على دومين حقيقي باسم يحتوي «Clinical Audit Syria»

المثال التالي يستخدم الدومين `clinicalaudit-syria.example.org` — استبدله بدومينك.

### أ. خادم (VPS) + DNS
1. أنشئ سجل `A` للدومين (أو `CNAME`) يشير إلى عنوان IP الخادم.
2. ثبّت Node.js 20+ و nginx و certbot على الخادم.

### ب. نسخ التطبيق
```bash
sudo mkdir -p /opt/clinicalaudit-syria
sudo cp -r app/* /opt/clinicalaudit-syria/
cd /opt/clinicalaudit-syria
sudo npm install --omit=dev
sudo cp .env.example .env && sudo nano .env
```

### ج. خدمة systemd
```bash
sudo cp deploy/clinicalaudit.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clinicalaudit
sudo systemctl status clinicalaudit
```

### د. شهادة HTTPS حقيقية + nginx
```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/clinicalaudit-syria
sudo sed -i 's/clinicalaudit-syria.example.org/YourDomain.org/g' /etc/nginx/sites-available/clinicalaudit-syria
sudo ln -s /etc/nginx/sites-available/clinicalaudit-syria /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YourDomain.org
```

بعد ذلك المنصة تعمل على `https://YourDomain.org` بشهادة موثوقة وتجديد تلقائي.
(بديل: تشغيل HTTPS من Node مباشرة عبر `TLS_KEY` و`TLS_CERT` في `.env`.)

> ملاحظة: إذا شغّلت خلف nginx فاترك `PORT=8080` ولا حاجة لفتح 8443.

---

## 4) تهيئة الرفع التلقائي إلى Google Drive (خطوة لازمة مرة واحدة)

حسابات الخدمة (Service Accounts) في Google **لا تملك مساحة تخزين** في Drive الشخصي، لذلك يعتمد الرفع
على جسر Apps Script يعمل بصلاحية حساب `ClinicalAudit.Syria@gmail.com` نفسه:

1. ادخل إلى <https://script.google.com> بحساب **ClinicalAudit.Syria@gmail.com**.
2. **New project** ← سمّه `Clinical Audit Drive Bridge`.
3. من داخل المنصة: **الدليل والمصطلحات ← إعداد الرفع التلقائي إلى Google Drive ← «نسخ سكربت Apps Script»**، والصقه في محرّر Apps Script مكان المحتوى الافتراضي.
4. غيّر السطر `var TOKEN = 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET';` إلى سرّ طويل خاص بك، واحفظ.
5. **Deploy ← New deployment ← Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy ← انسخ رابط `/exec`.
6. ارجع إلى المنصة، الصق **الرابط** و**رمز الحماية (Token)** في الحقلين، واضغط **«حفظ إعدادات Drive»**.
7. ستتحول الحالة إلى «الرفع التلقائي مُهيّأ ويعمل». جرّب رفع مستند والتأكد من ظهوره في:
   `My Drive / clinical audit data / CA-001-001 /`

كل مستند يُرفع من المنصة يُرفع تلقائياً إلى هذا المسار، ويُخزَّن أيضاً نسخة على الخادم
(`uploads/`) ليتيح التحميل من داخل المنصة حتى لو تعطّل Drive مؤقتاً.

---

## 5) النسخ الاحتياطي المشفّر والاستعادة

- النسخ تُحفظ في `backups/` بصيغة `.cab` مشفّرة AES-256-GCM.
- المفتاح في `backup.key` (أو `BACKUP_KEY_HEX` في البيئة). **احفظ نسخة منه خارج الخادم**؛ بدونه لا يمكن فك التشفير.
- نسخة تلقائية كل 6 ساعات + طلب `POST /api/backup` (لمنشئ الموقع فقط).
- استعادة:
```bash
node tools/restore-backup.js backups/db-2026-01-01T00-00-00.cab > restored.json
# أو الكتابة المباشرة (أوقف الخدمة أولاً)
sudo systemctl stop clinicalaudit
node tools/restore-backup.js backups/db-....cab --write
sudo systemctl start clinicalaudit
```

---

## 6) بنية المشروع

```
app/
├── server.js              # Express + HTTPS + كل مسارات API + فرض الصلاحيات
├── lib/
│   ├── auth.js            # bcrypt، الجلسات، requireAuth/requireCreator
│   ├── store.js           # مخزن JSON ذرّي (tmp + rename) + debounce
│   ├── drive.js           # Google Drive: جسر Apps Script + حساب خدمة احتياطي
│   └── backup.js          # AES-256-GCM نسخ احتياطية
├── public/index.html      # الواجهة الكاملة (RTL، بلا مكتبات خارجية)
├── data/db.json           # قاعدة البيانات
├── uploads/               # نسخ المستندات على الخادم
├── backups/               # النسخ المشفّرة .cab
├── certs/                 # شهادة ذاتية للتطوير
├── deploy/                # nginx.conf + clinicalaudit.service
├── tools/restore-backup.js
├── .env.example
├── start.sh
└── service_account.json   # بيانات حساب الخدمة (سرّي — لا تشاركه)
```

---

## 7) أهم مسارات الـ API

| المسار | الطريقة | الصلاحية |
|---|---|---|
| `/api/auth/signup` | POST | عام (برمز دعوة) |
| `/api/auth/login` | POST | عام |
| `/api/auth/logout` | POST | مسجّل |
| `/api/state` | GET | مسجّل — يرجع `me, users, subteams, projects, logs, drive, expiry` |
| `/api/projects` | PUT | مسجّل (منشئ/عضو حسب الحالة) |
| `/api/projects/:id/attachments` | POST | مسجّل — رفع + مزامنة Drive تلقائية |
| `/api/projects/:id/attachments/:attId/download` | GET | مسجّل |
| `/api/projects/:id/drive-report` | POST | مسجّل — توليد التقرير ورفعه |
| `/api/projects/:id/drive-all` | POST | مسجّل — رفع كل المستندات |
| `/api/members` | POST | **منشئ فقط** |
| `/api/members/:id` | DELETE | **منشئ فقط** (إخراج/حذف الحساب) |
| `/api/subteams` | PUT | **منشئ فقط** |
| `/api/drive/bridge` | GET/PUT | **منشئ فقط** |
| `/api/backup` | POST | **منشئ فقط** |
| `/api/backups` | GET | **منشئ فقط** |
| `/api/logs` | GET | مسجّل |

كل مسار محمي يتحقق من الجلسة على الخادم، وأي محاولة تجاوز تُرجع `401 unauthorized` أو `403 forbidden`.

---

## 8) ملاحظات تشغيلية

- **غيّر** `CREATOR_PASSWORD` و`INVITE_CODE` قبل الإنتاج.
- `service_account.json` و`backup.key` أسرار: لا تُرفع إلى Git، وقيّد صلاحياتها `chmod 600`.
- الواجهة تُخدَّم بـ `Cache-Control: no-store` لتفادي نسخ قديمة بعد التحديثات.
- الحد الأقصى للمرفق 25MB، والامتدادات المسموحة: pdf, docx, xlsx, png, jpg, jpeg.
- يُمنع رفع بيانات مرضى تعريفية (أسماء/أرقام ملفات/صور) — المنصة تنبّه لذلك في صفحة الدليل.

---

© Clinical Audit Syria — فريق التدقيق السريري، جامعة دمشق.
