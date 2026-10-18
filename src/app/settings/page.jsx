import { requirePageUser } from '@/lib/auth/pageGuard';
import { getSettings, toPublicSettings } from '@/lib/settings';
import SettingsForm from './SettingsForm';

export default async function SettingsPage() {
  const user = await requirePageUser('/settings');
  const settings = await getSettings(user.id);

  return (
    <div className="p-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-blue-600">设置</h1>
        <p className="mt-1 text-sm text-gray-600">仅支持 OpenAI 兼容接口。</p>
        <SettingsForm initial={toPublicSettings(settings)} />
      </div>
    </div>
  );
}
