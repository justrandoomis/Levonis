import React from 'react';
import { AlertTriangle, Trash2, X, RefreshCw } from 'lucide-react';

export interface DeleteConfirmModalProps {
  open: boolean;
  productName: string;
  isDeleting?: boolean;
  dir?: 'rtl' | 'ltr';
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  open,
  productName,
  isDeleting = false,
  dir = 'rtl',
  onClose,
  onConfirm,
}) => {
  if (!open) return null;

  const isRtl = dir === 'rtl';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
      dir={dir}
    >
      <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5 overflow-hidden">
        {/* Close icon button */}
        <button
          type="button"
          onClick={onClose}
          disabled={isDeleting}
          className="absolute top-4 end-4 text-zinc-400 hover:text-zinc-200 transition-colors p-1 rounded-lg hover:bg-zinc-800/80 disabled:opacity-40"
          aria-label={isRtl ? 'إغلاق' : 'Close'}
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-start gap-3.5 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/25 flex items-center justify-center shrink-0 text-red-400 mt-0.5">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id="delete-modal-title" className="text-base font-bold text-white leading-tight">
              {isRtl ? `حذف «${productName}» نهائياً؟` : `Delete “${productName}”?`}
            </h3>
            <p className="text-[13px] text-zinc-400 mt-2 leading-relaxed">
              {isRtl
                ? 'سيؤدي هذا إلى إزالة منتج الكتالوج وبياناته القابلة للتعديل نهائياً. ستبقى سجلات الطلبات السابقة والمعاملات المالية التاريخية محفوظة.'
                : 'This permanently removes the live catalog product and its editable product data. Historical orders and financial records will remain preserved.'}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-zinc-800/80 mt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="h-9 px-3.5 rounded-lg text-[13px] font-medium text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700/80 border border-zinc-700 transition-colors disabled:opacity-40"
          >
            {isRtl ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={isDeleting}
            className="inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-bold text-white bg-red-600 hover:bg-red-500 active:bg-red-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDeleting ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>{isRtl ? 'جارٍ الحذف…' : 'Deleting…'}</span>
              </>
            ) : (
              <>
                <Trash2 className="w-3.5 h-3.5" />
                <span>{isRtl ? 'حذف نهائي' : 'Delete permanently'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteConfirmModal;
