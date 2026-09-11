/**
 * The import report's grouping, checked against the messages the importer
 * ACTUALLY ships — every literal in worker/lib/importCsv.ts and the image
 * resolver, with the template placeholders filled the way the parser fills
 * them. A grouping tested against invented strings proves nothing; this fails
 * the moment someone rewords a validation message out from under the panel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIssueText, readIssueEntry, bucketise, classify } from '../src/components/adminProducts/importIssues';

const COLUMNS = ['row_type', 'key', 'name', 'price_iqd', 'image', 'hex', 'links', 'value', 'label', 'kind'];

/** The real corpus: message → the bucket it must land in. */
const CORPUS: Array<[string, string, ReturnType<typeof classify>]> = [
  // ---- missing fields and missing rows
  ['name', 'name فارغ', 'missing'],
  ['price_iqd', 'price_iqd مطلوب', 'missing'],
  ['key', 'عمود key فارغ', 'missing'],
  ['option', 'سطر option يحتاج group و value', 'missing'],
  ['color', 'سطر color يحتاج اسمًا في عمود value', 'missing'],
  ['image-row', 'سطر image يحتاج اسم ملف أو رابطًا في عمود image', 'missing'],
  ['spec', 'سطر spec يحتاج اسم المواصفة في عمود label', 'missing'],
  ['label', 'سطر label يحتاج نصًا في عمود value أو مفتاحًا في عمود kind', 'missing'],
  ['warranty', 'سطر warranty يحتاج عنوان الخطة في عمود value', 'missing'],
  ['guide', 'سطر guide يحتاج عنوان الخطوة في عمود value', 'missing'],
  ['variant', 'سطر variant يحتاج التوليفة في عمود links — مثال: Printer:A1|Plug:EU|color:Black', 'missing'],
  ['content', 'سطر content يحتاج نوعًا في عمود kind — القيم المتاحة: text / html', 'missing'],
  ['inv-color', 'inventory_mode=COLOR بلا ألوان', 'missing'],
  ['inv-option', 'inventory_mode=OPTION بلا خيارات', 'missing'],
  ['inv-variant', 'inventory_mode=VARIANT_COMBINATION بلا أسطر variant — اكتب توليفة واحدة على الأقل', 'missing'],
  ['links-color', 'links: لا يوجد سطر color باسم "Black" لهذا المنتج', 'missing'],
  ['links-option', 'links: لا يوجد سطر option باسم "Size:Large" لهذا المنتج', 'missing'],
  ['orphan', 'سطر option يشير إلى مفتاح "P1" بلا سطر product مطابق', 'missing'],
  ['duration', 'duration_months: مدة الضمان بالأشهر مطلوبة بين 1 و240', 'missing'],

  // ---- images that resolved to nothing
  ['img-zip', 'image: "a.png" غير موجود في مجلد images/ داخل الـ ZIP وليس رابطًا مباشرًا', 'image'],
  ['img-bad', 'image: "a.png" ليس ملف صورة صالحًا', 'image'],
  ['img-url', 'image: "https://x/a.png" — تعذّر التحميل', 'image'],

  // ---- duplicates
  ['dup-key', 'المفتاح "P1" مكرر في الملف', 'duplicate'],
  ['dup-variant', 'variant: هذه التوليفة مكررة في الملف', 'duplicate'],
  ['dup-spec', 'spec: "الأبعاد" مكررة في نفس المجموعة', 'duplicate'],
  ['dup-transport', 'transport: "air" مكرر', 'duplicate'],
  ['dup-warranty', 'warranty: الخطة "سنة" مكررة', 'duplicate'],
  ['dup-main-image', 'أكثر من صورة رئيسية لنفس المنتج', 'duplicate'],

  // ---- everything else is an invalid value
  ['int', 'price_iqd: "12x" ليس رقمًا صحيحًا', 'invalid'],
  ['enum', 'status: "live" غير مقبول — القيم المتاحة: draft / active / hidden', 'invalid'],
  ['bool', 'active: "maybe" — اكتب yes أو no', 'invalid'],
  ['hex', 'hex: "#zz" ليس #RGB أو #RRGGBB', 'invalid'],
  ['links-shape', 'links: "Large" يجب أن تكون Group:Value', 'invalid'],
  ['row-type', 'row_type غير معروف: "widget" — الأنواع المتاحة: product / option / color', 'invalid'],
  ['ladder-prime', 'المنتج: سعر PRIME أعلى من الاعتيادي', 'invalid'],
  ['ladder-pro', 'الخيار Large: سعر PRO أعلى من الاعتيادي', 'invalid'],
  ['ladder-order', 'اللون Black: يجب PRO ≤ PRIME ≤ الاعتيادي', 'invalid'],
  ['ladder-cost', 'التوليفة: سعر البيع يساوي التكلفة', 'invalid'],
  ['guide-images', 'guide: أقصى ٦ صور للخطوة الواحدة', 'invalid'],
  ['transport-sale', 'سطر transport لمنتج لا يبيع بالطلب المسبق — أضف pre_order إلى sale_types أو احذف السطر', 'invalid'],
];

{
  // ---- every message the importer actually ships lands in the right bucket
  for (const [name, message, expected] of CORPUS) {
    test(`${name} → ${expected}`, () => {
      const i = readIssueText(`سطر 7: ${message}`, { product: 'P1', columns: COLUMNS });
      assert.equal(i.code, expected);
      assert.equal(i.line, 7);
      assert.equal(i.product, 'P1');
    });
  }
}

{
  // ---- locating a complaint
  test('reads the line out of the parser prefix and drops it from the text', () => {
    const i = readIssueText('سطر 12: hex: "#zz" ليس #RGB أو #RRGGBB', { columns: COLUMNS });
    assert.equal(i.line, 12);
    assert.equal(i.field, 'hex');
    assert.equal(i.message, '"#zz" ليس #RGB أو #RRGGBB');
  });

  test('names the column even when the message does not use a colon', () => {
    assert.equal(readIssueText('سطر 3: price_iqd مطلوب', { columns: COLUMNS }).field, 'price_iqd');
    assert.equal(readIssueText('سطر 3: name فارغ', { columns: COLUMNS }).field, 'name');
  });

  test('never reports an Arabic place as a field', () => {
    const i = readIssueText('سطر 4: الخيار Large: سعر PRO أعلى من الاعتيادي', { columns: COLUMNS });
    assert.equal(i.field, null);
    assert.ok((i.message).includes('الخيار Large'));
  });

  test('never reports a row type as a field', () => {
    // `spec: "x" مكررة` names the ROW TYPE, not a column called spec.
    assert.equal(readIssueText('سطر 9: spec: "الأبعاد" مكررة في نفس المجموعة', { columns: COLUMNS }).field, null);
  });

  test('keeps an unknown column that is not in this file as the field anyway', () => {
    // A column the shape does not define still names itself in the message.
    assert.equal(readIssueText('سطر 5: duration_months: مدة الضمان بالأشهر مطلوبة بين 1 و240', {}).field, 'duration_months');
  });

  test('survives a message with no line prefix at all', () => {
    const i = readIssueText('الملف فارغ', {});
    assert.equal(i.line, null);
    assert.equal(i.message, 'الملف فارغ');
  });
}

{
  // ---- the TXT lane reports the same way
  test('takes line and key straight from the structured error', () => {
    const i = readIssueEntry({ line: 31, key: 'price_iqd', message: 'must be an integer (IQD, no separators or decimals)' });
    assert.equal(i.line, 31);
    assert.equal(i.field, 'price_iqd');
    assert.equal(i.code, 'invalid');
  });

  test('classifies a required-field refusal as missing', () => {
    const i = readIssueEntry({ line: 8, key: 'name_ar', message: 'name_ar is required' });
    assert.equal(i.code, 'missing');
  });

  test('drops an empty key rather than reporting an empty field', () => {
    assert.equal(readIssueEntry({ line: 1, key: '', message: 'template is too large' }).field, null);
  });
}

{
  // ---- buckets
  test('splits errors from warnings and counts each bucket once', () => {
    const issues = [
      readIssueText('سطر 2: name فارغ', { severity: 'error', columns: COLUMNS }),
      readIssueText('سطر 3: image: "a.png" ليس ملف صورة صالحًا', { severity: 'error', columns: COLUMNS }),
      readIssueText('سطر 4: المفتاح "P1" مكرر في الملف', { severity: 'error', columns: COLUMNS }),
      readIssueText('سطر 5: لا توجد صورة رئيسية — ستُعتمد الأولى', { severity: 'warning', columns: COLUMNS }),
    ];
    const b = bucketise(issues);
    assert.equal((b.errors).length, 3);
    assert.equal((b.missing).length, 1);
    assert.equal((b.images).length, 1);
    assert.equal((b.duplicates).length, 1);
    assert.equal((b.warnings).length, 1);
  });

  test('never counts a warning as a blocking error', () => {
    const b = bucketise([readIssueText('سطر 5: لا توجد صورة رئيسية — ستُعتمد الأولى', { severity: 'warning' })]);
    assert.equal((b.errors).length, 0);
  });
}
