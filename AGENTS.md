# הוראות עבודה לסוכני AI

קראו קובץ זה לפני שינוי בתוסף.

## יעד קשיח

- התוסף מיועד לאוצריא `0.9.96`.
- אין להוסיף API, manifest field או התנהגות שתלויים ב־`0.9.97+`.
- אין לשנות את מאגר אוצריא עצמו כדי לעקוף מגבלה בתוסף, אלא אם המשתמש ביקש זאת במפורש.

## סדר קריאה

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/COMPATIBILITY.md`
4. `CONTRIBUTING.md`
5. הקובץ הרלוונטי לשינוי
6. הבדיקות הרלוונטיות

## גבולות בעלות

- `marker-domain.js`: לוגיקה טהורה בלבד. אין DOM, אין `Otzaria`, אין storage.
- `marker-runtime.js`: SDK, שגיאות, logging והגנת handlers בלבד.
- `app.js`: UI, orchestration, storage, lifecycle ותפריט הקשר.
- `index.html`: מבנה ונגישות. אין inline event handlers.
- `style.css`: theme roles של אוצריא בלבד. אין CDN ואין צבעי component קשיחים כשקיים role מתאים.

## invariants שאסור לשבור

- מפתח הגדרות: `marker_settings`.
- prefix של רשומות: `highlight:`.
- root של תפריט ההקשר: `marker-root`.
- עד חמישה צבעים פעילים בתפריט, גם אם נשמרים יותר צבעים.
- foreground/background אינם רשאים לנהל במקביל את אותו context menu.
- כל settings עוברים normalization.
- גיבוי קיים חייב להמשיך להיטען.
- שינוי סגנון צבע מסנכרן הדגשות קיימות.

## עבודה עם select ותפריטים

- אין להחזיר תפריטי select גולמיים לממשק.
- ה־select המקורי נשאר מקור הנתונים כדי לשמור תאימות ללוגיקה.
- השתמשו ב־`enhanceSelects`, `syncEnhancedSelect` ו־`syncAllEnhancedSelects`.
- לאחר החלפת options דינמית יש לסנכרן את הרכיב המותאם.
- אפשרות צבע צריכה להציג swatch אמיתי.

## עבודה עם ניהול צבעים

- `.color-row-main` משתמש ב־grid areas; אין להציב ילדים בקואורדינטות ידניות חופפות.
- פעולות מצב, סדר ומחיקה שייכות ל־`.color-row-actions`.
- בורר הגוון המותאם ממורכז ב־viewport.
- כפתור פלטה ליד HEX רשאי לפתוח את בוחר הצבעים הנייטיבי רק בעקבות פעולת משתמש ישירה.
- preview חייב להתעדכן עבור גוון, שקיפות, radius וסוג סימון.

## שינוי בטוח

1. קראו את ה־diff הקיים ושמרו שינויים של המשתמש.
2. העדיפו שינוי קטן ומקומי.
3. הוסיפו בדיקה ללוגיקה חדשה.
4. הריצו syntax, tests ו־`git diff --check`.
   בדיקות Node חייבות לכלול גם `test/compatibility.test.js`.
5. בדקו IDs ייחודיים וסוגריים מאוזנים ב־CSS.
6. ארזו עם אוצריא ודרשו DESIGN_GUIDE נקי.
7. אל תצהירו על בדיקה חזותית אם לא הופקה תמונה או לא הורץ הממשק בפועל.

## סימני אזהרה

- שכבת CSS חדשה שמתקנת selector ישן בלי להבין את ה־cascade.
- שימוש ב־`innerHTML` עם נתון שלא עבר `escapeHtml`.
- קריאת SDK ישירה שאינה עוברת דרך runtime.
- מחיקה או החלפה מלאה בלי rollback.
- הוספת permission שלא נדרש לפיצר.
- שינוי שמסתמך על התנהגות דפדפן שאינה קיימת ב־WebView של אוצריא.
