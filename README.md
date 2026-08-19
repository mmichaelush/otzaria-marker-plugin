# תוסף מרקר לאוצריא

תוסף לסימון טקסט בצבעים, ניהול הדגשות, הוספת הערות ותגיות, חיפוש, ייצוא וגיבוי.

- [מדריך משתמש מלא](docs/USER_GUIDE.md)
- [ארכיטקטורה ודיבוג](docs/ARCHITECTURE.md)
- [תאימות אוצריא ומסלול שדרוג](docs/COMPATIBILITY.md)
- [מדריך תרומה ו־PR](CONTRIBUTING.md)
- [הוראות לסוכני AI](AGENTS.md)
- [עמוד התוסף בחנות אוצריא](https://otzaria.org/plugins/6a6069b8dd175558ae6e4071)

## תאימות

- אוצריא `0.9.96`
- `minAppVersion` במניפסט: `0.9.96`
- אין שימוש ב־API שהוצג לראשונה ב־`0.9.97` ומעלה.
- `reader.revealHighlight` הוא ה־API החדש ביותר שבו נעשה שימוש, והוא זמין מ־`0.9.96`.

## התקנה קצרה

1. פותחים את [עמוד התוסף בחנות](https://otzaria.org/plugins/6a6069b8dd175558ae6e4071) או את חנות התוספים מתוך אוצריא.
2. מתקינים ומאשרים את ההרשאות המבוקשות.
3. כדי להפעיל סנכרון ותפריט הקשר ברקע, מאשרים את ההרשאה `app.run_on_startup`.

לכל שלבי ההתקנה והשימוש ראו [מדריך המשתמש](docs/USER_GUIDE.md).

## מבנה

- `index.html` — מסך התוסף.
- `background.html` — מופע הרקע לסנכרון ולתפריט ההקשר.
- `js/marker-domain.js` — כללי דומיין טהורים ונרמול נתונים.
- `js/marker-runtime.js` — עטיפת SDK, שגיאות ולוגים.
- `js/app.js` — תזמור, אחסון, UI ו־lifecycle.
- `docs/ARCHITECTURE.md` — תיעוד תחזוקה ודיבוג.
- `docs/USER_GUIDE.md` — תיעוד מלא למשתמשים.
- `CONTRIBUTING.md` — setup, בדיקות, אריזה וכללי PR.
- `AGENTS.md` — גבולות עבודה ו־invariants לסוכני AI.

## בדיקות מקומיות

מתיקיית התוסף:

```text
node --check js/marker-domain.js
node --check js/marker-runtime.js
node --check js/app.js
node --test test/domain.test.js test/runtime.test.js test/context-menu.test.js test/compatibility.test.js
git diff --check
```

בדיקת התנהגות מלאה צריכה להתבצע בתוך אוצריא `0.9.96`, כולל סימון בחירה, בחירת צבע, ניווט להדגשה, גיבוי/שחזור והפעלה עם ובלי הרשאת הרצה ברקע.

## דיבוג

לוגים של התוסף מתחילים ב־`[marker][app]`. שגיאות SDK כוללות `method`, `code`, `category` ו־`retryable`. פרטי הארכיטקטורה והבעלות בין foreground/background נמצאים ב־`docs/ARCHITECTURE.md`.
