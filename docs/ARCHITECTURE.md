# ארכיטקטורת תוסף המרקר

## עקרונות

התוסף מחולק לשלוש שכבות עם גבולות ברורים:

- `js/marker-domain.js` — כללי דומיין טהורים: נרמול הגדרות ותגיות, צבעים, טווחי טקסט, זיהוי בחירה ובניית סגנון. אין בו גישה ל־DOM או ל־SDK.
- `js/marker-runtime.js` — תשתית ריצה: קריאות `Otzaria.call`, שגיאות SDK מובנות (`code`, `category`, `retryable`), לוגר עם prefix, והגנה על handlers אסינכרוניים.
- `js/app.js` — תזמור: state של הסשן, DOM/rendering, פעולות highlight, אחסון, תפריט ההקשר ו־lifecycle.

הסקריפטים נטענים בסדר הזה גם ב־`index.html` וגם ב־`background.html`:

1. `marker-domain.js`
2. `marker-runtime.js`
3. `app.js`

נשמרו classic scripts ו־namespaces גלובליים (`MarkerDomain`, `MarkerRuntime`) כדי להתאים למארח אוצריא ול־SDK הקיים.

## Lifecycle ובעלות runtime

`plugin.boot` קובע אם ה־instance הוא foreground או background. כאשר קיימת הרשאת `app.run_on_startup`, ה־background הוא בעל מנוע הסנכרון והרישום של תפריט ההקשר; ה־foreground אחראי על UI בלבד. שינוי הרשאות מעביר בעלות בצורה מפורשת.

כל handlers של `Otzaria.on` עוברים דרך `protectEvent`, ולכן כשל אסינכרוני נרשם עם שם האירוע ואינו יוצר unhandled rejection.

`normalizeBootContext` מרכז את פרטי המארח שמגיעים ב־`plugin.boot`, ו־`ownsLegacyRuntime` מרכז את כלל הבעלות של 0.9.96. דגלי capability שמוחזרים מהנרמול הם מידע בלבד; הם אינם מתירים קריאת API חדש. פירוט הגבול ומסלול השדרוג נמצא ב־`docs/COMPATIBILITY.md`.

## חוזי נתונים

- הגדרות נשמרות תחת `marker_settings`.
- כל highlight נשמר תחת מפתח `highlight:<highlightId>`.
- שדות highlight קיימים (`bookId`, `sectionIndex`, `colorId`, `sourceRange`, `version`, `etag`, `status`, `groupId`) נשמרים ללא שינוי.
- `normalizeSettings` ו־`normalizeTags` מופעלות בנקודות הקלט והייצוא הרלוונטיות כדי להגן מפני נתונים ישנים או חלקיים; רשומות highlight שנקראות מהאחסון עוברות עיבוד לפי הפעולה שמטפלת בהן.

## Rendering ורכיבי ממשק

`renderHighlightList` אחראית למסננים, כרטיסים, קיבוץ ותפריטי הצבע של כל הדגשה. `renderSettings` אחראית לעורך הצבעים ולערכי מסך ההגדרות.

רכיבי `select` נשארים מקור האמת לערך ולאירועי `change`, אך מוצגים דרך שכבה מותאמת:

- `enhanceSelects` מאתר selectים סטטיים ודינמיים.
- `enhanceSelect` יוצר `.otz-select` צמוד ל־select המקורי.
- `syncEnhancedSelect` משקף options, value, disabled ו־swatch.
- `syncAllEnhancedSelects` נדרש לאחר עדכון תכנותי רחב.

כך אפשר לשפר את העיצוב בלי לשכתב את מסלולי הסינון, השמירה והעריכה.

עורך הצבעים מפריד בין שלושה אזורים:

1. `.color-row-main` - grid יציב.
2. בחירת גוון ושם.
3. `.color-row-actions` - הפעלה, סדר ומחיקה.

חלונית הגוון עצמה היא overlay ממורכז. ה־input מסוג color מוסתר ומשמש רק לפתיחת בוחר המערכת בעקבות לחיצה על כפתור הפלטה של שדה HEX.

`addColorDialog` הוא מסלול יצירה דו-שלבי: ערכי טופס זמניים ותצוגה מקדימה נשמרים מחוץ ל־`settings` עד לאירוע `submit`. רק `שמור והוסף צבע` מוסיף רשומה ומפעיל `saveSettings`; סגירה או ביטול אינם משנים נתונים.

## תפריט הקשר

התוסף רושם root יחיד בשם `marker-root` עבור `reader-selection` ו־`reader-page-shape-selection`. במצב שורת צבעים הוא שולח `type: color-row`, `title: מרקר` ועד חמישה צבעים. במצב submenu הוא שולח תפריט בעל שם עם אותם צבעים.

אוצריא `0.9.96` עשויה לא להציג את הכותרת של `color-row`, מפני שהמרת ה־host ל־`AppContextMenuEntry.colorRow` אינה שומרת את הכותרת. אין לפצל שוב את הכותרת לפריט נפרד, משום שהדרישה היא root יחיד.

## שמירה, concurrency ו־rollback

- שינויי UI נשמרים דרך `scheduleAutoSave`, עם revision לכל status כדי למנוע מהודעה ישנה לדרוס תוצאה חדשה.
- `saveSettings` מעדכן תפריט הקשר ומסנכרן סגנונות קיימים רק כאשר חתימת הצבעים השתנתה.
- פעולות update משתמשות ב־version/etag של אוצריא כאשר הם קיימים.
- ייבוא גיבוי שומר snapshot ומנסה rollback אם הפעולה נכשלת באמצע.
- מחיקה מרוכזת שומרת רשימה זמנית לצורך undo.

## מגבלות ידועות

- בדיקת Node אינה מריצה DOM או WebView.
- מיקום ועיצוב בוחר הצבעים הנייטיבי נשלטים על ידי מערכת ההפעלה.
- תפריטים מותאמים חייבים להיבדק ידנית בתוך WebView של אוצריא, במיוחד במובייל ובמצב כהה.
- כותרת color-row תלויה במימוש המארח של `0.9.96`.

## איפה לדבג

חיפוש לפי prefix `[marker][app]` מציג לוגים של התוסף. שגיאת SDK היא `MarkerSdkError`; השדות `method`, `code`, `category` ו־`retryable` זמינים ישירות על האובייקט. כשל באירוע יציין גם את שם האירוע.

לבעיות UI בדוק את `app.js`; לבעיות נרמול/טווחים בדוק את `marker-domain.js`; לבעיות תקשורת עם אוצריא בדוק את `marker-runtime.js` ואת קוד השגיאה של ה־SDK.

## בדיקות מקומיות

מתיקיית התוסף:

```text
node --check js/marker-domain.js
node --check js/marker-runtime.js
node --check js/app.js
node --test test/domain.test.js test/runtime.test.js test/context-menu.test.js test/compatibility.test.js
git diff --check
```

בדיקות אלה אינן מחליפות הרצה בתוך אוצריא, אך הן מונעות שגיאות תחביר ורגרסיות בחוזי הדומיין בלי תלות חיצונית.
