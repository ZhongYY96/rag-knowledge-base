# 检索策略：dense / hybrid 的实测结论

> 语料：2 篇文档、46 块；评测集 12 条（easy 6 / hard 4 / unanswerable 2）；topK 3/5/10 各跑一遍。

## 结论先说

**当前语料下，混合检索没有增益，反而掉召回。所以默认用 dense，混合作为可配置能力保留。**

| 配置 | easy 命中 | hard 命中 | hard Recall |
|---|---|---|---|
| dense | 100% | 100% | **100%** |
| hybrid rrf k=60 w=0.7:0.3 | 100% | 100% | **87.5%** |
| hybrid w=1:0（等价纯向量） | 100% | 100% | 100% |
| hybrid w=0:1（纯关键词） | 100% | 100% | 87.5% |

topK 从 3 拉到 10，结论不变——不是"召回条数不够"，是关键词路本身就漏了一块。

## 根因

用权重做二分定位：`w=1:0` 恢复正常、`w=0:1` 复现掉分化 ⇒ **漏召回来自关键词路，不是融合逻辑**。

漏的那条是「网管数据的四层对象分别是什么？」里的第二个 gold 块（`④ 告警层`）。
分词后这一块的词项和查询重叠度低，在 top-10 里排不进去；0.3 的权重足以把它挤出融合结果。

## 为什么这不代表混合检索没用

1. **dense 已经天花板**：46 块、术语高度集中，向量检索几乎必中，没有提升空间可言
2. **没有真正考"精确串"的场景**：语料里 `TargetDict`、`curalert` 这类词在文档里密集出现，dense 也能命中
3. 混合的价值要在大语料（几百篇、上万块）+ 稀疏词汇（型号、单号、错误码）+ 小 topK 下才显现

## 复现方式

```bash
node scripts/eval.mjs --retrieval-only --mode dense
node scripts/eval.mjs --retrieval-only --mode hybrid
node scripts/eval.mjs --retrieval-only --mode hybrid --weights 1,0   # 定位用
node scripts/eval.mjs --retrieval-only --mode hybrid --topk 10       # 排除条数因素
```

## 已实现但默认关闭的能力

- 索引形态：`dense + sparse` 命名向量（`scripts/reindex.mjs` 重建）
- 查询：两路 prefetch → RRF（k 可配，**必须显式传，Qdrant 默认 k=2 是坑**）/ DBSF
- 权重、候选倍数、融合算法都可在设置页调
- 旧索引（单路向量）自动降级为纯向量，不会报错

## 下一步怎么验证

语料扩到 40+ 篇、评测集扩到 40 条（其中 10 条是型号/错误码/单号类查询），再跑一次对照。
如果那时 hybrid 仍然不涨，就把这个能力删掉——**留着不生效的配置项比没有更糟**。
