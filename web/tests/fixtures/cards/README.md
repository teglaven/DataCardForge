# 卡片层差分夹具（cards/）

这一份 JSON 是**函数卡**的裁判格式，和 `../xlayer/` 一样是"同一份输入、两侧实现、逐字段对拍"。
两侧都必须跑它：

| 侧 | 入口 | 它判什么 |
|---|---|---|
| TypeScript | `web/tests/cardFixtures.test.ts` | 卡片描述如何变成**端口绑定**（`portId` 是身份、不许按位置）、夹具本身是否自洽（表达式数=列数、行数一致、列名唯一、契约用例必须与产出宽度不一致）、v2 快照往返后绑定与参数是否原样保留 |
| C++ | `backend/tests/card_fixture_run.cpp`（ctest `card_fixtures`） | 用真实 `NodeRegistry` 建同一张卡，比对每个输出的**列名（annotation）**、逐元素数值、结构化错误 `code`+`params`，并断言 error 节点不留下旧结果 |

两侧判的不是同一件事，这是故意的：前端不会算数（B 计划），它唯一能弄错的是"怎么描述这张卡"；
后端不会画 UI，它唯一能弄错的是"按描述算出了什么"。

## 格式

```jsonc
{
  "name": "用例名",
  "matrices": [                      // 夹具里的 matrix id 就是线上的 id（两侧都不做映射）
    { "id": 1, "columns": [
      { "posName": "Pos.1", "annotation": "A", "data": [1, 2, 3] }   // NaN/±Infinity 用字符串
    ] }
  ],
  "card": {
    "kind": "formula",
    "inputs": [{ "portId": "src", "target": { "type": "matrix", "cardId": 1, "matrixId": 1 } }],
    "signatureId": "builtin:expression-columns",
    "params": { "formulas": [{ "name": "double", "expression": "A * 2" }] }
  },
  "expect": {                        // 成功用例
    "outputs": [{ "outputId": "result", "columns": [
      { "name": "double", "data": [2, 4, 6] }      // name 必须作为该列的 annotation 落地
    ] }]
  },
  "expectError": { "code": "columnContractViolation", "params": { "expected": 1, "actual": 2 } }
}
```

`expect` 与 `expectError` 二选一。错误用例还会被要求：结果矩阵必须为空（不许留着上一轮的数）。

## 加用例时的纪律

1. **先想清楚这个用例在守哪条规则**——端口身份、K 由签名定、参数与数据分离、列数契约、
   错误必须结构化、NaN 语义。守不住任何一条的用例不是夹具，是装饰。
2. **不要为了变绿放宽比对**。数值是精确相等（浮点表达式两侧应当逐位一致）；真需要容差就
   在夹具里显式加字段，而不是在任一侧写 `tolerance`。
3. **两侧一起改**。只改一侧的夹具等于让裁判只吹一个哨。
4. 新增签名时至少给一个**异形输出**（行数/列数与输入无关）的用例，否则"形状跟着数据变"
   这类错误永远不会被抓住。
