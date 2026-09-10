# הוראות עבודה לסוכני AI

קראו קובץ זה לפני כל שינוי בתוסף.

## יעד קשיח

- התוסף מיועד לאוצריא `0.9.97` ומעלה, ונבדק גם על `0.9.98`.
- `minAppVersion` הוא **הגרסה שבה נוסף ה-API החדש ביותר שבשימוש** — לא הגרסה
  האחרונה שיצאה. אין להעלות אותו "כדי להיות מעודכן": כל העלאה חוסמת התקנה אצל
  משתמשים בגרסה קודמת.
- שימוש ב-API חדש דורש עדכון של שלושה מקומות יחד: `manifest.minAppVersion`,
  הטבלה `API` ב-`test/compatibility.test.js`, ו-`app-version` +
  `api-reference-url` ב-`.github/workflows/release.yml`.
- אין לשנות את מאגר אוצריא כדי לעקוף מגבלה בתוסף, אלא אם המשתמש ביקש במפורש.

## סדר קריאה

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/COMPATIBILITY.md`
4. `CONTRIBUTING.md`
5. הקובץ הרלוונטי לשינוי
6. הבדיקות הרלוונטיות

## גבולות בעלות

| קובץ | מותר | אסור |
|------|------|------|
| `js/marker-domain.js` | לוגיקה טהורה, נרמול, בניית payloads | DOM, `Otzaria`, timers, state |
| `js/marker-i18n.js` | קטלוג, בחירת שפה, תרגום DOM | לוגיקה עסקית |
| `js/marker-runtime.js` | `Otzaria.call` / `on`, שגיאות, לוגר, תור | DOM, כללי דומיין |
| `js/marker-richtext.js` | עורך ההערות, הליכה על ה-DOM לסינון | SDK, מדיניות סינון משלו |
| `js/marker-core.js` | הגדרות, הדגשות, תרומות, גיבוי, דיווח, lifecycle | DOM |
| `js/marker-ui.js` | rendering, טפסים, דיאלוגים | קריאת SDK ישירה, כללי דומיין |
| `index.html` | מבנה ונגישות | inline event handlers, לוגיקה |
| `css/style.css` | תפקידי צבע ו-radius tokens של אוצריא | צבע קשיח, CDN, `@import` |

הגבולות נאכפים ב-`test/compatibility.test.js`. אל תעקפו את הבדיקה — תקנו את הקוד.

## invariants שאסור לשבור

- מפתח ההגדרות: `marker_settings`. קידומת הרשומות: `highlight:`.
- מזהי התרומות: `marker-colors`, `marker-highlight-actions` (ובתוכו
  `marker-note` ו-`marker-remove`), `marker-toolbar`, וקידומת הצבעים `mark-`.
  הם מופיעים גם ב-`manifest.json` וגם ב-`marker-domain.js` וחייבים להישאר זהים.
- **`metadata.source` חייב להיות `manual`.** ה-Host מקבל רק
  `manual`/`ai`/`import`/`sync` ודוחה כל ערך אחר ב-
  `error.invalid_params: unsupported highlight source` — כלומר אף הדגשה לא
  נוצרת. בנו metadata אך ורק דרך `MarkerDomain.buildHighlightMetadata`;
  אובייקט `metadata: { ... }` ידני ב-`marker-core.js` מפיל בדיקה.
- **ה-harness אוכף את חוזה ה-Host.** `test/helpers/harness.js` מוודא allowlist
  של שדות, ערכים סגורים וטווחים ב-`setHighlight`, `updateHighlight`,
  `addContextMenuItem` ו-`addToolbarItem`. אל תרפו את הוולידציה כדי "לעבור
  בדיקה" — היא הדבר היחיד שתופס payload שהמארח האמיתי ידחה.
- **אין מופע רקע, וזו החלטה.** אוצריא מוחקת את ההדגשות של מופע כשהוא נסגר
  (`PluginBridgeAdapter.dispose` → `PluginHighlightRegistry.removeInstance`),
  ולכן מופע רקע ארעי היה מוחק בעצמו כל סימון שצייר. אל תחזירו
  `app.run_on_startup` בלי לפתור קודם את בעלות ההדגשות ואת מחיקתן מהדף.
- **אף מטפל לחיצה אינו בודק `isEngine`.** אוצריא מוסרת אירוע ממוקד (תפריט,
  פקד, קיצור) למופע אחד בלבד, ולכן אין כפילות למנוע — והבדיקה גרמה ללחיצות
  להיעלם בלי זכר. `isEngine` שייך רק לאירועי שידור
  (`reader.sectionContentChanged`) ולעבודת עלייה.
- מטפל לחיצה חייב `await whenBooted()` לפני שהוא קורא `settings` — הלחיצה
  עשויה להיות מה שהעיר את הדף.
- **`update` לתפריט מותר תמיד, `add` הוא נפילה בלבד.** הפריטים רשומים ברמת
  התוסף מהמניפסט, ולכן עדכון שורד את סגירת הדף; רישום חדש נקשר למופע הרושם.
- **כל מחרוזת שנכנסת ל-payload עוברת `safeHighlightText` או `safeMenuText`.**
  תו בקרה אחד מפיל את הקריאה כולה עם `error.invalid_params`, בלי שההדגשה
  תצויר — בדיוק כמו הבאג של `metadata.source`.
- **`styleWithCSS` חייב להישאר כבוי.** עם הדגל דלוק `execCommand('bold')`
  פולט `<span style="font-weight:bold">`, וה-sanitizer אינו שומר שום הצהרה
  מלבד `font-size` — כך שכל העיצוב בהערה נמחק בשמירה. `noteStyleTags` ממפה
  את צורת ה-CSS חזרה לתגיות, בשביל מנועים שמתעלמים מהדגל ובשביל הדבקות.
- כל `settings` עוברים `normalizeSettings`; כל רשומת highlight עוברת
  `normalizeHighlight`. אין דרך אחרת להיכנס למאגר.
- מזהה highlight עובר `isSafeHighlightId` לפני שהוא הופך למפתח אחסון.
- גיבוי קיים חייב להמשיך להיטען — `parseBackup` תומך ב-`schemaVersion` 1 ו-2.
- שינוי סגנון צבע מסנכרן הדגשות קיימות (`restyleStoredHighlights`).
- חלקי בחירה רב-פסקתית חולקים `groupId` ונמחקים תמיד יחד.
- אין לעטוף את `feedback.report` ב-timeout — היא ממתינה לדיאלוג של המשתמש.
- `ui.print` ו-`ui.exportPdf` חייבות להיקרא **ישירות מ-handler של לחיצה**;
  `await` לפניהן מאבד את ה-user activation ומחזיר `error.forbidden`.

## הערות עשירות — כלל האבטחה

- **`noteHtml` מסונן ביציאה, בכל פעם מחדש.** הוא יכול להגיע מקובץ גיבוי זר.
  כל הפיכה שלו ל-markup — כרטיס, עורך, ייצוא HTML — עוברת ב-
  `MarkerRichText.sanitize`. „כבר סיננו בשמירה” אינה הצדקה.
- **המדיניות נשארת ב-`marker-domain.js`** (`noteTagFor`, `safeNoteHref`,
  `safeNoteFontSize`), כי שם אפשר לבדוק אותה. אין לשכפל allowlist לתוך
  `marker-richtext.js` — הבדיקה תיכשל.
- הרחבת ה-allowlist דורשת בדיקה חדשה ב-`domain.test.js` שמראה מה **נדחה**,
  לא רק מה מתקבל.
- `note` (טקסט) ו-`noteHtml` (markup) נשמרים תמיד יחד. הטקסט הוא מה שהחיפוש
  והייצוא לטקסט/Markdown קוראים.

## i18n — הכלל שהכי קל לשבור

כל מחרוזת שהמשתמש רואה חייבת לעבור תרגום:

- בקוד: `t('טקסט')` עם ליטרל, לא עם משתנה.
- ב-HTML: `data-i18n` על האלמנט, `data-i18n-attr="title,aria-label"` לתכונות.
- מחרוזת שמגיעה ל-`t()` דרך משתנה חייבת להירשם ב-`DYNAMIC_STRINGS`
  שב-`test/helpers/i18n-strings.js`.
- **אל תשמרו תוצאה של `t()` במשתנה שנוצר פעם אחת** (למשל ב-binding בעלייה) —
  היא תיתקע בשפה שהייתה פעילה אז. העבירו פונקציה, כמו ב-`guard`.

`test/i18n.test.js` נכשל על מחרוזת חסרה, על מפתח מיותר בקטלוג, על placeholder
שאבד בתרגום, ועל תרגום שזהה למקור. אחרי הוספת מחרוזת — הריצו אותו.

## עבודה עם select ותפריטים

- אין להחזיר select גולמי לממשק. ה-select המקורי נשאר מקור הערך והאירועים.
- השתמשו ב-`enhanceSelect`, `syncEnhancedSelect`, `syncAllEnhancedSelects`.
- אחרי החלפת options תכנותית — חובה לסנכרן.
- אפשרות צבע חייבת להציג swatch אמיתי.

## עבודה עם ניהול צבעים

- `.color-row-main` הוא grid; אין להציב ילדים בקואורדינטות ידניות חופפות.
- פעולות מצב, סדר ומחיקה שייכות ל-`.color-row-actions`.
- בוחר הצבעים הנייטיבי נפתח רק בעקבות פעולת משתמש ישירה.
- ה-preview חייב להתעדכן עבור גוון, שקיפות, radius וסוג סימון.
- `draftSettings` הוא מצב הטופס לפני שמירה. `settings()` מחזיר אותו כשהוא קיים.
  אל תכתבו ל-`Core.settings` ישירות.

## שינוי בטוח

1. קראו את ה-diff הקיים ושמרו שינויים של המשתמש.
2. העדיפו שינוי קטן ומקומי.
3. לוגיקה חדשה שאפשר לבדוק בלי DOM ובלי SDK — שייכת ל-`marker-domain.js`
   ומקבלת בדיקה.
4. הריצו את הכול:
   ```text
   for f in js/*.js i18n/*.js; do node --check "$f"; done
   node --test test/domain.test.js test/runtime.test.js test/core.test.js \
               test/i18n.test.js test/ui.test.js test/compatibility.test.js
   git diff --check
   ```
5. בדקו IDs ייחודיים וסוגריים מאוזנים ב-CSS (`test/ui.test.js` עושה את זה).
6. ארזו עם אוצריא ודרשו דו״ח DESIGN_GUIDE נקי.
7. **אל תצהירו על בדיקה חזותית שלא בוצעה.** בדיקות Node אינן מריצות DOM.

## סימני אזהרה

- שכבת CSS חדשה שמתקנת selector ישן בלי להבין את ה-cascade.
- `innerHTML` עם נתון שלא עבר `escapeHtml`.
- קריאת SDK שאינה עוברת דרך `MarkerRuntime`.
- `catch` ריק שמסתיר כשל אמיתי. השתמשו ב-`callSoft` כשהכשל באמת לא משנה,
  וב-`MarkerSdkError.isUnsupported` כדי להבדיל בין "המארח לא מכיר" לכשל.
- הוספת permission שאין לה פיצ׳ר — הבדיקה תיכשל.
- הצהרה על הרשאת בסיס (`plugin.storage.*`, `ui.feedback`, `app.info.read`,
  `notifications.send`, `events.subscribe:theme.changed`) — מיותרת מ-0.9.97.
- מחיקה או החלפה מלאה בלי rollback.
- הסתמכות על התנהגות דפדפן שאינה קיימת ב-WebView של אוצריא: `window.open`
  מנוטרל, זום דפדפן מבוטל, והורדה דרך `<a download>` אינה אמינה — לשמירת קובץ
  יש `MarkerCore.saveFileAs`.
