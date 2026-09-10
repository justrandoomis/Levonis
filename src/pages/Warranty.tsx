import React, { useState, useEffect } from 'react';
import { Shield, Plus, Printer } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { api } from '../lib/api';
import { DeviceCard } from '../components/warranty/DeviceCard';
import { AddDevicePanel } from '../components/warranty/AddDevicePanel';
import { WARRANTY_STRINGS } from '../components/warranty/strings';
import type { Device } from '../components/warranty/types';

export default function Warranty() {
  const { lang, loc } = useLanguage();
  const s = WARRANTY_STRINGS[lang];
  const { isAuthenticated } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    if (isAuthenticated) {
      api
        .get<{ devices: Device[] }>('/api/devices')
        .then((res) => {
          if (active && res.devices) setDevices(res.devices);
        })
        .catch(() => {})
        .finally(() => {
          if (active) setLoading(false);
        });
    } else {
      setLoading(false);
    }
    return () => {
      active = false;
    };
  }, [isAuthenticated, refreshKey]);

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">
                {loc('مركز الضمان المعتمد', 'Warranty Center', 'ناوەندی گەرەنتی')}
              </h1>
              <p className="text-xs text-zinc-400">
                {loc('إدارة أجهزتك ومطالبات الصيانة', 'Manage your registered devices and claims', 'بەڕێوەبردنی ئامێرەکانت')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowAdd(!showAdd)}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-bold text-xs flex items-center gap-1.5 shadow"
          >
            <Plus className="w-4 h-4" />
            <span>{showAdd ? loc('إغلاق', 'Close', 'داخستن') : loc('إضافة جهاز', 'Add Device', 'زیادکردنی ئامێر')}</span>
          </button>
        </div>

        {showAdd && (
          <div className="mb-6 p-4 rounded-2xl bg-zinc-900/80 border border-zinc-800">
            <AddDevicePanel
              lang={lang}
              s={s}
              refreshKey={refreshKey}
              onLinked={(device) => {
                setDevices((prev) => [device, ...prev]);
                setShowAdd(false);
                setRefreshKey((k) => k + 1);
              }}
            />
          </div>
        )}

        {loading ? (
          <div className="p-8 rounded-2xl bg-zinc-900/40 border border-zinc-800/60 text-center text-zinc-500 text-xs animate-pulse">
            {loc('جاري تحميل الأجهزة...', 'Loading registered devices...', 'بارکردنی ئامێرەکان...')}
          </div>
        ) : devices.length > 0 ? (
          <div className="space-y-4">
            {devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                lang={lang}
                s={s}
                onOpenClaim={() => {}}
                onRemove={() => {
                  setDevices((prev) => prev.filter((d) => d.id !== device.id));
                }}
              />
            ))}
          </div>
        ) : (
          <div className="p-8 rounded-2xl bg-zinc-900/60 border border-zinc-800 text-center text-zinc-400">
            <Printer className="w-12 h-12 mx-auto mb-3 text-zinc-600" />
            <p className="font-semibold text-white mb-1">
              {loc('لا توجد أجهزة مسجلة في الضمان', 'No devices registered', 'هیچ ئامێرێک تۆمار نەکراوە')}
            </p>
            <p className="text-xs text-zinc-500 mb-4">
              {loc(
                'أدخل الرقم التسلسلي لطابعتك لربطها بالضمان الرسمي لشركة ليفونيس.',
                'Register your 3D printer serial number to activate warranty coverage.',
                'ژمارەی زنجیرەیی چاپکەرەکەت بنووسە بۆ چالاککردنی گەرەنتی.'
              )}
            </p>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-semibold text-xs border border-zinc-700"
            >
              {loc('تسجيل طابعة جديدة', 'Register New Device', 'تۆمارکردنی ئامێری نوێ')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
