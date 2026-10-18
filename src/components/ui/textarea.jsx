'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 支持自动增高的 Textarea。
 *
 * 补充背景：原来这个组件把 `{...props}` 直接摊到原生 <textarea> 上，
 * 而调用方传了 `maxRows={5}` —— 那是 react-textarea-autosize 的 prop，
 * 不是 DOM 属性，所以 React 会警告：
 *   "React does not recognize the `maxRows` prop on a DOM element."
 * 而且自动增高本身也从来没生效过。
 *
 * 这里用 ~15 行原生实现补上，不引额外依赖：
 *   - maxRows 从 props 里解构出来，不再漏到 DOM 上（警告消失）
 *   - **只有传了 maxRows 才启用自动增高**；没传就是普通 textarea，行为完全不变
 *     （所以 /chat 那个页面不受影响）
 */
const Textarea = React.forwardRef(
  ({ className, maxRows, rows = 1, onChange, ...props }, ref) => {
    const innerRef = React.useRef(null);
    const autoGrow = maxRows != null;

    // 合并外部 ref 和内部 ref
    const setRef = React.useCallback(
      (node) => {
        innerRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const resize = React.useCallback(() => {
      const el = innerRef.current;
      if (!el || !autoGrow) return;

      // 必须先复位成 auto 才能量到内容的真实高度，否则 scrollHeight 只会越来越大
      el.style.height = 'auto';

      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const maxHeight = lineHeight * maxRows;
      const next = Math.min(el.scrollHeight, maxHeight);

      el.style.height = `${next}px`;
      // 超过上限才出现滚动条，否则隐藏（不然会出现一条没用的小滚动条）
      el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }, [autoGrow, maxRows]);

    // 挂载、maxRows 变化、以及受控 value 被外部改动（比如提交后清空）时重新量
    React.useLayoutEffect(() => {
      resize();
    }, [resize, props.value, props.defaultValue]);

    const handleChange = React.useCallback(
      (e) => {
        onChange?.(e);
        resize();
      },
      [onChange, resize],
    );

    return (
      <textarea
        className={cn(
          'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        ref={setRef}
        rows={rows}
        onChange={handleChange}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
