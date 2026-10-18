/**
 * remark 插件：把文本节点里的 [citation:N] / [N] 换成自定义节点 <cite>。
 *
 * 为什么用插件而不是切字符串：
 *   react-markdown 渲染文本节点时不给你"改写某段文字"的入口。
 *   唯一干净的扩展点就是在 AST 阶段把文本节点拆开，插入自定义节点，
 *   再用 components.cite 映射成 React 组件。
 */

const RE = /\[citation:\s*([\d,\s]+)\]|\[(\d[\d,\s]*)\](?!\()/gi;

export default function remarkCitations() {
  return (tree) => {
    const walk = (node) => {
      if (!node || !Array.isArray(node.children)) return;

      for (let i = 0; i < node.children.length; i += 1) {
        const child = node.children[i];

        if (child.type !== 'text') {
          walk(child);
          continue;
        }

        RE.lastIndex = 0;
        if (!RE.test(child.value)) continue;
        RE.lastIndex = 0;

        const parts = [];
        let last = 0;
        let m;

        while ((m = RE.exec(child.value)) !== null) {
          if (m.index > last) parts.push({ type: 'text', value: child.value.slice(last, m.index) });

          for (const piece of (m[1] ?? m[2] ?? '').split(',')) {
            const index = Number(piece.trim());
            if (Number.isInteger(index) && index > 0) {
              parts.push({
                type: 'cite',
                data: { hName: 'cite', hProperties: { dataIndex: index } },
              });
            }
          }
          last = m.index + m[0].length;
        }

        if (last < child.value.length) parts.push({ type: 'text', value: child.value.slice(last) });
        if (parts.length === 0) continue;

        node.children.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
    };

    walk(tree);
  };
}
