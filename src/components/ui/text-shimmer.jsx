'use client';

import { createContext, memo, useContext } from 'react';
import styles from './text-shimmer.module.css';

/**
 * 标记「当前正在渲染装饰副本」。
 *   undefined → 不在 TextShimmer 里
 *   false     → 在 TextShimmer 的真实层
 *   true      → 在装饰层（不产生真实文本节点）
 */
const DecorativeCopy = createContext(undefined);

const cx = (...parts) => parts.filter(Boolean).join(' ');

function TextContent({ children, className }) {
  // 只有在装饰层里、且孩子是字符串时，才改用 ::after 伪元素渲染
  const generated = useContext(DecorativeCopy) === true && typeof children === 'string';

  return (
    <span className={cx(styles.text, className)} data-shimmer-text={generated ? children : undefined}>
      {generated ? null : children}
    </span>
  );
}

/**
 * 带流光的文字。文字本身始终是可选中、可被无障碍读取的；高光是一层纯装饰副本。
 *
 * @param {object} props
 * @param {string|React.ReactNode} props.children 文字。传字符串时装饰层用伪元素渲染，
 *        不会产生重复的 DOM 文本；传组合节点（含图标）时会渲染两遍，此时请勿在其中放
 *        副作用或 id。
 * @param {boolean} props.active 是否播放流光
 * @param {string} props.color 高光颜色，对应 CSS 变量 --shimmer-color
 * @param {string} props.className 透传到最外层
 */
export const TextShimmer = memo(function TextShimmer({ children, active = false, className, color }) {
  // 嵌套保护：已经在装饰层里了，就只渲染纯文本，避免装饰无限套娃
  if (useContext(DecorativeCopy) !== undefined) {
    return <TextContent className={className}>{children}</TextContent>;
  }

  // 同一个元素实例在两个位置复用 —— React 元素是不可变描述，这是允许的
  const content = typeof children === 'string' ? <TextContent>{children}</TextContent> : children;

  return (
    <span
      className={cx(styles.root, className)}
      data-shimmer={active || undefined}
      style={color ? { '--shimmer-color': color } : undefined}
    >
      <DecorativeCopy.Provider value={false}>
        <span className={styles.content}>{content}</span>
      </DecorativeCopy.Provider>

      {active && (
        /*
         * inert 必须写成布尔 true。
         *
         * 踩过的坑：这里渲染用的**不是** node_modules 里的 react@18.3.1，
         * 而是 Next.js 自己打包的那一份 —— next/dist/build/webpack-config.js
         * 把 'react' 别名到了 'next/dist/compiled/react'，前后端都走它。
         *
         * 所以 inert="" 会警告「Received an empty string for a boolean attribute」，
         * 而且**会被当成 false**，也就是 inert 等于没生效。
         */
        <span className={styles.decoration} aria-hidden="true" inert={true}>
          <span className={styles.sweep}>
            <DecorativeCopy.Provider value={true}>
              <span className={cx(styles.content, styles.highlight)}>{content}</span>
            </DecorativeCopy.Provider>
          </span>
        </span>
      )}
    </span>
  );
});

export default TextShimmer;
