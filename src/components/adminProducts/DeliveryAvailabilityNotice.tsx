import type { ProductDeliveryOptions } from '../../../packages/shipping/src/shipping';
import { standardDeliveryFeeIqd } from '../../../packages/shipping/src/shipping';

/** Preview the same explicit allow-list used at checkout; never change saved restrictions. */
export default function DeliveryAvailabilityNotice({ options, printer }: { options: ProductDeliveryOptions | null; printer: boolean }) {
  const standard = options?.standard.enabled !== false;
  const personal = options?.personal.enabled !== false;
  return (
    <div className={`mb-3 rounded-lg border px-3 py-2 text-xs leading-6 ${!standard || !personal ? 'border-amber-500/50 bg-amber-950/25 text-amber-200' : 'border-zinc-700 text-zinc-300'}`}
      role={!standard || !personal ? 'alert' : undefined} data-delivery-availability-preview>
      <p>التوصيل العادي: {standard ? `متاح — ${standardDeliveryFeeIqd(printer).toLocaleString('en-US')} د.ع للشحنة كاملة قبل مزايا العضوية` : 'معطّل لهذا المنتج'}.</p>
      <p>التوصيل الشخصي: {personal ? 'مسموح — تحدد التعرفة النهائية في عرض سعر الطلب' : 'معطّل لهذا المنتج'}.</p>
      {(!standard || !personal) && <p>الطريقة المعطّلة لن تظهر في سلة تحتوي هذا المنتج. فعّل الطريقة المطلوبة أو اختر «استخدام التعرفة العامة»، ثم احفظ المنتج.</p>}
      {!standard && !personal && <p className="font-semibold">كل طرق التوصيل للمنزل معطّلة. يبقى الاستلام من المخزن متاحًا إذا كان مفعّلًا في إعدادات المتجر.</p>}
    </div>
  );
}
