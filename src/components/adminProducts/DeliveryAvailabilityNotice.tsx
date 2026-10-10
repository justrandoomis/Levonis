import type { ProductDeliveryOptions } from '../../../packages/shipping/src/shipping';
import { standardDeliveryFeeIqd } from '../../../packages/shipping/src/shipping';

/** Preview the same explicit allow-list used at checkout; never change saved restrictions. */
export default function DeliveryAvailabilityNotice({ options, printer }: { options: ProductDeliveryOptions | null; printer: boolean }) {
  const standard = options?.standard.enabled !== false;
  const personal = options?.personal.enabled !== false;
  return (
    <div className={`mb-3 text-xs leading-6 ${!standard || !personal ? 'lv-alert lv-alert-warning text-text-primary' : 'rounded-lg border border-border-subtle px-3 py-2 text-text-secondary'}`}
      role={!standard || !personal ? 'alert' : undefined} data-delivery-availability-preview>
      <p>التوصيل العادي: {standard ? `متاح — ${standardDeliveryFeeIqd(printer).toLocaleString('en-US')} د.ع للشحنة كاملة قبل مزايا العضوية` : 'معطّل لهذا المنتج'}.</p>
      <p>التوصيل الشخصي: {personal ? 'مسموح — تحدد التعرفة النهائية في عرض سعر الطلب' : 'معطّل لهذا المنتج'}.</p>
      {(!standard || !personal) && <p>الطريقة المعطّلة لن تظهر في سلة تحتوي هذا المنتج. فعّل الطريقة المطلوبة أو اختر «استخدام التعرفة العامة»، ثم احفظ المنتج.</p>}
      {!standard && !personal && <p className="font-semibold">كل طرق التوصيل للمنزل معطّلة. يبقى الاستلام من المخزن متاحًا إذا كان مفعّلًا في إعدادات المتجر.</p>}
    </div>
  );
}
