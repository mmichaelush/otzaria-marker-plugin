# תרומה לתוסף מרקר

תודה על הרצון לתרום. המטרה היא לאפשר PR קטן, ברור ובטוח שמתאים לאוצריא `0.9.96`.

## דרישות מוקדמות

- Node.js עם `node:test`.
- התקנת אוצריא `0.9.96` לבדיקת אינטגרציה ואריזה.
- Git.
- אין צורך ב־npm install: לתוסף אין תלויות רשת או שלב build.

## התחלה מהירה

1. שכפלו או פצלו את המאגר.
2. צרו branch ייעודי לשינוי.
3. קראו את `docs/ARCHITECTURE.md` ואת `AGENTS.md`.
4. בצעו שינוי ממוקד.
5. הוסיפו או עדכנו בדיקות ביחס לסיכון.
6. הריצו את כל פקודות האימות.
7. ארזו באמצעות אוצריא וודאו שה־DESIGN_GUIDE עובר ללא אזהרות.

## מפת קבצים

- `manifest.json`: זהות, גרסה, הרשאות ותרומות לממשק אוצריא.
- `index.html`: מבנה המסך בלבד. אין להכניס אליו לוגיקה עסקית.
- `css/style.css`: ערכת הממשק. הצבעים חייבים להגיע ממשתני theme של אוצריא.
- `js/marker-domain.js`: פונקציות טהורות וחוזי נתונים.
- `js/marker-runtime.js`: גבול SDK, שגיאות ולוגים.
- `js/app.js`: rendering, DOM, lifecycle, storage ותזמור.
- `background.html`: טעינת אותם סקריפטים במופע הרקע.
- `test/`: בדיקות Node ללא DOM.
- `docs/`: תיעוד משתמש, ארכיטקטורה ותחזוקה.
- `docs/COMPATIBILITY.md`: חוזה 0.9.96 ונקודות ההרחבה הרדומות לגרסאות הבאות.

## כללי תאימות

1. יעד המארח הוא אוצריא `0.9.96` בלבד.
2. אין להשתמש ב־API שנוסף ב־`0.9.97` או מאוחר יותר.
3. אין לשנות `minAppVersion` בלי החלטת release מפורשת.
4. אין להוסיף CDN, גופן מרוחק, analytics או הרשאת רשת.
5. יש לשמור על classic scripts ועל סדר הטעינה `domain`, `runtime`, `app`.
6. תפריט ההקשר חייב להישאר פריט שורש יחיד `marker-root`.

## כללי לוגיקה

- כלל דומיין חדש צריך להיכנס ל־`marker-domain.js` כאשר אפשר לבדוק אותו בלי DOM ובלי SDK.
- קריאת SDK עוברת דרך `MarkerRuntime.call` או `callRaw`.
- handler של אירוע אוצריא חייב לעבור דרך `protectEvent`.
- נתוני הגדרות חייבים לעבור דרך `normalizeSettings`.
- מזהי highlight חייבים לעבור דרך `isSafeHighlightId` לפני שימוש במפתח אחסון.
- אסור למחוק שדות קיימים מרשומת highlight בלי migration מפורש ובדיקת שחזור.

## כללי UI

- השתמשו רק בתפקידי צבע כמו `--color-surface-container`, `--color-primary` ו־`--color-outline-variant`.
- השתמשו רק במשתני radius המוגדרים. אין `border-radius` קשיח בפיקסלים.
- אייקונים צריכים להתאים לשפה של Fluent System Icons ולהיות SVG מקומי.
- אין להוסיף תלות רשת לאייקונים.
- תפריטי בחירה חדשים צריכים להשתמש ברכיב `.otz-select`; ה־select המקורי נשאר מקור הערך והאירועים.
- רכיבים דינמיים חייבים לעבוד ב־280px, בדסקטופ ובמצב כהה.
- אין להוסיף טקסט הדרכה שמכסה פעולה או מפריע לעבודה; הסברים צריכים להיות קצרים וסריקים.

## רכיב התפריט המותאם

`enhanceSelects` משפר את כל רכיבי ה־select בלי לשנות את הקוד שקורא מהם:

1. ה־select המקורי מוסתר חזותית אך נשאר ב־DOM.
2. `.otz-select` מציג trigger ורשימת אפשרויות בסגנון אוצריא.
3. בחירה בתפריט מעדכנת את `select.value` ומשגרת אירוע `change` רגיל.
4. `syncEnhancedSelect` חייב להיקרא לאחר שינוי options או value בצורה תכנותית.
5. ערכי צבע שמזהים `settings.colors` מקבלים swatch אוטומטי.

אל תעבירו לוגיקה עסקית לתוך רכיב התפריט.

## שינוי סכמת נתונים

שינוי מבנה `settings` או highlight דורש:

1. ברירת מחדל ב־`DEFAULT_SETTINGS` או במסלול יצירת הרשומה.
2. נרמול לאחור ב־`normalizeSettings` או בפונקציית קריאה ייעודית.
3. בדיקה לנתון חסר, ישן ולא תקין.
4. עדכון גיבוי ושחזור.
5. תיעוד ב־`docs/ARCHITECTURE.md`.

## בדיקות חובה

```text
node --check js/marker-domain.js
node --check js/marker-runtime.js
node --check js/app.js
node --check test/context-menu.test.js
node --test test/domain.test.js test/runtime.test.js test/context-menu.test.js test/compatibility.test.js
git diff --check
```

בדיקות ידניות באוצריא `0.9.96`:

- יצירה והסרה של הדגשה בבחירת טקסט רגילה ובבחירת page shape.
- שינוי כל סוגי הצבע והסגנון.
- פתיחה, עריכה ומחיקה מרשימת ההדגשות.
- חיפוש, סינון, מיון וקיבוץ.
- פעולות מרוכזות וביטול מחיקה.
- גיבוי, מיזוג והחלפה מלאה.
- הפעלה עם ובלי `app.run_on_startup`.
- מצב בהיר, מצב כהה ורוחבים 280, 390, 680 ו־1180 פיקסלים לפחות.

## אריזה

```powershell
& 'C:\Program Files\otzaria\otzaria.exe' pack-plugin `
  'C:\path\to\otzaria-marker-plugin' `
  --output 'marker.otzplugin' `
  --force
```

האריזה חייבת להציג:

```text
✓ העיצוב תואם לתיעוד (DESIGN_GUIDE).
```

## תוכן PR

PR טוב כולל:

- תיאור בעיה והתנהגות צפויה.
- פירוט קבצים וחוזים שהשתנו.
- תוצאות בדיקות אוטומטיות וידניות.
- צילומי מסך לפני ואחרי לשינוי UI.
- הצהרה מפורשת שלא נעשה שימוש ב־API מעל `0.9.96`.
- מעבר של `test/compatibility.test.js`, כולל allowlist קריאות SDK ובדיקת מודל ה־startup הפעיל.
- הערות migration או rollback כאשר נתונים משתנים.
