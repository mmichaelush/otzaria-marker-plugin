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
| `js/marker-background.js` | הפעלת המנוע ב-`background.html` ותו לא | כל דבר אחר |
| `index.html` | מבנה ונגישות | inline event handlers, לוגיקה |
| `background.html` | טעינת domain → i18n → en.js → runtime → core → background | DOM, CSS, UI |
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
- **כל מופע מצייר. אל תגדרו ציור בבעלות.** `getAllHighlights` עושה dedup לפי
  `(ownerPluginId, highlightId)`, ולכן אותו סימון אצל ארבעה מופעים מצויר פעם
  אחת. כל ניסיון לבחור "מי מצייר" נכשל בכל פעם שהניחוש היה שגוי — המנוע כובה,
  ההרשאה נדחתה, הלחיצה נותבה למופע אחר — ואז לא צויר **כלום**, בלי שום שגיאה.
  `ownsEngine` מחליט רק מי רשאי **לרשום** תרומה חדשה.
- **`reconcileHighlights` מנקה, לא מדלג.** מה שהמופע הזה מצייר ואינו ב-
  `shouldDraw` (נמחק במקום אחר, או שהספר הוסתר) יורד מהדף. דילוג על ספר מושתק
  במקום ניקוי הוא הסיבה שהסתרה פעלה רק במופע שקיבל את הלחיצה.
- **קריאה שנכשלה אינה אחסון ריק — וזו אינה הערת סגנון.** `storage.list`
  שנכשל והוחזר כ-`[]` רוקן את רשימת ההדגשות, ו-`reconcileHighlights` מחק
  בנאמנות את כל מה שהיה מצויר בספר. `loadHighlights` שומר את מה שכבר היה ביד,
  מסמן `storeComplete=false`, וסבב הניקוי מוותר עד קריאה שלמה. אל תחזירו ברירת
  מחדל ריקה מקריאת אחסון.
  **ולכלל הזה יש חצי שני:** `pollRevision` חייב לנסות שוב כל עוד
  `storeComplete` הוא `false`, גם כשהאסימון לא זז. בלי זה הסירוב למחוק רק הפך
  את הנזק לקבוע — הרשומה נשארה חסרה מהרשימה ומהדף עד הפעלה מחדש.
- **כל רצף קריאות חייב לעבור דרך `callRaw` ולכבד את קצב המארח.** מגביל הקצב
  של אוצריא נותן 50 קריאות ואז מסרב לכל השאר כל עוד הפערים קטנים מ-10ms —
  גם בלולאת `await`, לא רק ב-`Promise.all` (הפירוט ב-`docs/ARCHITECTURE.md`).
  אל תוסיפו `Promise.all` על רשימה שאורכה נקבע בידי המשתמש; יש
  `MarkerRuntime.mapLimit`. ואל תרחיבו את הניסיון החוזר מעבר ל-
  `error.rate_limited` — רק הוא מובטח כ"לא רץ בכלל".
- **`callSoft` על פעולה שהמשתמש ביקש הוא באג.** בליעה שקטה של כישלון היא
  בדיוק מה שהופך תקלה זמנית ל"התוסף לא מגיב": אין סימון, אין מחיקה, ואין
  הודעה. כל מסלול שמתחיל בלחיצה של משתמש חייב להסתיים בסימון, במחיקה או
  בהודעה שמסבירה למה לא.
- **`version` ו-`etag` לא נכתבים לאחסון.** הם של העותק של מופע מסוים; שמירתם
  גרמה לשני חלונות לדרוס זה את זה בכל סבב דגימה.
- **ל-`reader.selection_changed` אין עוגן.** ה-payload הוא הצורה הישנה
  (`text`, `currentBookId`, `currentIndex`) בלי `sourceRange` ובלי
  `sections`. אל תריצו עליו `selectionTargets` ותצפו לתשובה —
  `selectionTouchesHighlight` הוא השער, והוא נופל לרמת מקטע כשאין טווחים.
- **`reader.revealHighlight` היא per-instance.** רק המופע שצייר את הרשומה
  רשאי לבקש אותה. מהדף חובה לפתוח ואז `reader.scrollToSection` —
  `openBookAtRef` מנווט ל-ref (פרק/סימן) ולא לשורה.
- **הדף והמנוע מדברים רק דרך `REVISION_KEY`.** אין ערוץ הודעות בין מופעים.
  כל כתיבה שהצד השני צריך לראות חייבת להסתיים ב-`bumpRevision()`; כל קריאה
  מחדש עוברת ב-`pollRevision()`.
- **שלושה דברים מחזיקים את המנוע בחיים, ואם אחד יורד הבאג הגדול חוזר:**
  `contributes.background.entrypoint`, `activationEvents` לא ריק,
  ו-`startup.keepAlive: true` יחד עם `app.background_keep_alive`.
- **אל תוסיפו `app.startup` ל-`activationEvents`.** השעון החד-פעמי שלו קורא
  ל-`_activate` בלי לבדוק אם כבר רץ מנוע, `_activateOnDemand` יוצא מיד כי
  `_activeBackgroundPlugins` כבר מחזיק את התוסף, ואז `_activating` לעולם אינו
  מתנקה. `dispatchEventToPlugin` בודקת `queueIfBootPending` לפני שהיא מחפשת
  controller, ולכן **כל** לחיצה נכנסת לתור שלא ירוקן — גם כשהלשונית פתוחה
  ובריאה. הפירוט ב-`docs/ARCHITECTURE.md`, ו-`test/compatibility.test.js`
  אוכף את זה.
- **הפקד בסרגל אינו `openPlugin`,** והדגל `marker_toolbar_button` חייב לשבת
  במפתח אחסון משלו — ה-`when` של ה-Host משווה ערך שמור שלם ואינו נכנס לתוך
  `marker_settings`.
- **מטפלי אירועי שידור אינם מגודרים ב-`isEngine` בעיוורון.**
  `PluginRuntimeDispatcher._selectEventTargets` מוסר שידור למופעים הקדמיים
  החיים כשיש כאלה, ונופל למנוע הרקע רק כשאין אף אחד — כלומר כשלשונית התוסף
  פתוחה, המנוע אינו מקבל `reader.selection_changed` ולא
  `reader.current_ref_changed` בכלל. מטפל שרק *מעדכן תרומה* (עדכון מותר מכל
  מופע) חייב לרוץ בשני הצדדים — וכך גם מטפל שמצייר, כי כל מופע מצייר.
  היוצא מן הכלל הוא `reader.sectionContentChanged`, שנמצא ב-
  `_backgroundEventTopics` ולכן תמיד מועדף למנוע.
- **אף מטפל לחיצה אינו בודק `isEngine`.** אוצריא מוסרת אירוע ממוקד (תפריט,
  פקד, קיצור) למופע אחד בלבד, ולכן אין כפילות למנוע — והבדיקה גרמה ללחיצות
  להיעלם בלי זכר. `isEngine` שייך לעבודת עלייה ולשאלה מי רשאי
  **לרשום** תרומה חדשה — לא לשאלה מי מצייר.
- **טקסט התצוגה עובר ב-`applyHolyNamePolicy`**, וההחלפה היא בתצוגה בלבד:
  הרשומה נשמרת בנוסח הספר. כל מקום שמציג, מדפיס או מייצא טקסט מסומן חייב
  לעבור ב-`bookText` שב-`marker-ui.js`.
- **`selectedTextOf` מעדיף `renderedSelectedText`.** המיפוי של אוצריא
  מהטקסט המוצג למקור מבצע אינטרפולציה יחסית בתוך קטעים שנכתבו מחדש, והחזרה
  לסדר המקור הזיזה את הטקסט השמור בכמה תווים. אל תהפכו את הסדר בחזרה.
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
- `ui.exportPdf` (ו-`window.print()`) חייבות להיקרא **ישירות מ-handler של
  לחיצה**; `await` לפניהן מאבד את ה-user activation ומחזיר `error.forbidden`.
  `ui.print` אינה בשימוש בכוונה — ראו `docs/COMPATIBILITY.md`.

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
   node --test "test/*.test.js"
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
- הוספת permission שאין לה פיצ׳ר — הבדיקה תיכשל. (היוצאים מן הכלל מפורטים
  ב-`compatibility.test.js`: הרשאות שמגבות תרומה במניפסט ולא קריאת RPC.)
- קובץ גופן שנכנס חזרה לחבילה. הגופנים נטענים מ-`fonts.resolveFamilies`.
- הצהרה על הרשאת בסיס (`plugin.storage.*`, `ui.feedback`, `app.info.read`,
  `notifications.send`, `events.subscribe:theme.changed`) — מיותרת מ-0.9.97.
- מחיקה או החלפה מלאה בלי rollback.
- הסתמכות על התנהגות דפדפן שאינה קיימת ב-WebView של אוצריא: `window.open`
  מנוטרל, זום דפדפן מבוטל, והורדה דרך `<a download>` אינה אמינה — לשמירת קובץ
  יש `MarkerCore.saveFileAs`.
