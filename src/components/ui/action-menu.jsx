'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 用 portal 渲染到 <body> 的下拉菜单。
 *
 * 为什么不能用普通的 `position: absolute`：
 *   菜单的祖先里只要有一层 `overflow: hidden` / `overflow-x: auto` / `overflow-y: auto`，
 *   它就会被**裁掉**。而且 `z-index` 再高也没用 —— z-index 管的是层叠顺序，
 *   管不了 overflow 裁剪，两者是两套独立的机制。
 *
 *   本项目踩的就是这个：卡片有 `overflow-hidden`（做圆角），
 *   表格外层有 `overflow-x-auto`（做横向滚动），菜单直接从这两层里被切掉。
 *
 * 解法：`createPortal` 到 document.body，用 `position: fixed` + 实时计算坐标。
 * 附带要处理的三件事：
 *   1. 滚动/缩放时菜单不会自己跟着动 —— 要监听 scroll（capture 才能拿到内部容器的滚动）
 *   2. 菜单不在触发器的 DOM 子树里 —— 点外关闭要同时排除触发器和菜单本身
 *   3. SSR 阶段没有 document —— 挂载后再 portal
 */
export default function ActionMenu({ open, onOpenChange, trigger, children, align = 'end' }) {
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(
      align === 'end'
        ? { top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) }
        : { top: r.bottom + 8, left: r.left },
    );
  }, [align]);

  // 打开时定位；并跟随滚动/缩放，否则菜单会"飘"在原地而触发器已经滚走
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, update]);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      onOpenChange(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="text-gray-500 hover:text-gray-700"
      >
        {trigger}
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: pos.top, ...(pos.right != null ? { right: pos.right } : { left: pos.left }) }}
          className="w-48 bg-white rounded-md shadow-lg border z-50 py-1"
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
