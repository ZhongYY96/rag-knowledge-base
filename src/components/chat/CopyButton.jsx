'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * 复制按钮。
 *
 * 原理：
 *   1. 现代浏览器用 navigator.clipboard.writeText（需安全上下文 + 用户手势）
 *   2. 老浏览器/非 https 回退到隐藏 textarea + document.execCommand('copy')
 *
 * 为什么不用 clipboard.readText：读剪贴板会弹权限框，用户很容易拒绝，
 * 而且我们只需要"写"，不需要读。
 */
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('execCommand copy failed');
}

export default function CopyButton({ text, className = '', label = '复制' }) {
  const [state, setState] = useState('idle'); // idle | done | error

  useEffect(() => {
    if (state === 'idle') return undefined;
    const t = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(t);
  }, [state]);

  async function onClick() {
    try {
      await copyText(text ?? '');
      setState('done');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title="复制这段内容"
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
        state === 'done'
          ? 'bg-green-50 text-green-700'
          : state === 'error'
            ? 'bg-red-50 text-red-600'
            : 'bg-white/80 text-gray-400 hover:bg-gray-100 hover:text-gray-700'
      } ${className}`}
    >
      {state === 'done' ? <Check size={12} /> : <Copy size={12} />}
      {state === 'done' ? '已复制' : state === 'error' ? '复制失败' : label}
    </button>
  );
}
