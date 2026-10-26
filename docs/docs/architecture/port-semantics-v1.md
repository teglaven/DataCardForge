# 端口语义规格 v1（port-semantics-v1）

- **日期**：2026-10-26
- **状态**：🔒 语义已锁定 / **字节布局未冻结**
- **定位**：函数卡端口的**单一事实源**。`FunctionSignature` 注册表（内置函数）、未来的
  `dc_plugin.h`（C 投影）、Rust `repr(C)` 镜像（WASM 层）、卡片层差分夹具，都是本文件的投影；
  冲突时以本文件为准，改本文件必须走新决策记录。
- **上游决策**：[卡片数据结构 v2](../decisions/2026-10-26-card-schema-v2.md)
- **姊妹文档**：[后端协议 v1](backend-protocol-v1.md)（传输层；本文件是函数层）

## 语义总览（自然语言嵌套伪 JSON）

### 函数签名 FunctionSignature

```jsonc
{
  id: "稳定标识符，如 builtin:svd / builtin:expression-columns。发布后永不改",
  version: "签名自身修订号。语义变化必须 bump 版本，不得悄悄改同 id 行为",
  displayName: "给人看的名字。随便改，与 id 解耦",

  inputs: [                       // N 个输入端口声明。N 由签名定，是函数的“插座形状”
    {
      portId: "稳定身份。显示名改名 ≠ 改 portId；端口重排 ≠ 改 portId。连线只认它，永不按位置",
      kind: "matrix | cell | scalar —— 该端口接受的数据形状",
      required: "true|false。可选端口未连线时的语义 = ABSENT（见 evaluation.absence），不是空矩阵",
      dtype: "v1 只有 f64（double）。未来新增 dtype 值 = bump 签名 version"
    }
  ],

  params: [                       // 参数与数据分离：标量/配置走这里，绝不混进 inputs
    {
      name: "参数名，稳定身份规则同 portId",
      type: "number | string | bool | enum",
      default: "缺省值。有缺省的参数在 UI 上可折叠",
      range: "数值域 / enum 的 choices",
      note: "params 是签名的一部分，不是数据流图的一部分：改参数不产生、不删除任何边"
    }
  ],

  outputs: [                      // K 个输出声明。K 由签名固定，永不由数据决定
    {
      outputId: "稳定身份，规则同 portId",
      kind: "matrix | table | scalar",
      note: "变长/变个数的结果装进一个 table 输出，绝不‘有多少行就出多少个输出’。异构多输出（如 SVD 的 U/S/V）用多个固定 outputId 表达"
    }
  ],

  errors: [                       // 结构化错误：沿用 backend-protocol-v1 §结构化错误
    { code: "如 shapeMismatch / singularMatrix", params: "占位参数；服务端不生成人类散文" }
  ],

  traits: {
    deterministic: "同输入+同参数 ⇒ 同输出。差分夹具的前提",
    cancellable: "是否支持协作式取消",
    progress: "是否上报进度",
    nanPolicy: "propagate | drop | error —— 每个函数必须声明 NaN 语义（max-headroom 决策的要求）"
  }
}
```

### 求值语义 evaluation（一个能力，一个入口）

```jsonc
{
  inputSide: "元数据推、数据拉（vtable）。宿主先推 n_inputs + 每端口描述符（kind/形状/是否 ABSENT）；
              插件按需调 host.pull(portId, row_range) 获取只读视图 (ptr, rows, cols, ld)。
              视图列主序连续，元素 (i,j) = data[i + j*ld]；ld 使行窗口/子矩阵零拷贝、允许对齐填充。
              边界检查必须用 ld*cols，memcpy 不得按 rows*cols*8 想当然",

  outputSide: "arena 推。插件调 host.alloc(outputId, rows, cols) 取得可写视图，列主序写入。
               arena 是分块 bump 分配器：每个输出内部连续，arena 整体不必连续。
               宿主在输出完成后做四点校验：
               ① 尺寸与声明一致；② K 个输出全部填齐（少填 = 结构化错误，不是未定义行为）；
               ③ data + ld*cols 落在 arena 界内；④ 非有限值按签名的 nanPolicy 处置",

  cancelProgress: "取消钩子与进度钩子挂在同一条 vtable 上，与求值同一个入口结构。
                   ‘双接口同功能’被本项目永久禁止：size 只能是循环次数，不能是分支条件——
                   同一张卡在小数据和大数据上必须走同一条代码路径、给同一种答案",

  absence: "可选输入未连线时，描述符 kind = ABSENT —— 显式缺席。
            空矩阵（0×0）是合法数据，≠ 缺席；禁止 NULL+0 哨兵编码"
}
```

### 所有权与边界 ownership（任何语言投影都不得违反的不变量）

```jsonc
{
  inputViews: "借用。插件不得释放、不得写入（const 语义）；视图生命周期不超出本次求值调用",
  outputViews: "内存由宿主 arena 分配，插件只写不拥有；释放统一由宿主完成（谁分配谁释放）",
  abiHygiene: "跨界结构体里不出现 STL / Eigen / Qt / std::string 类型；容器层无布局契约——
               只用 (ptr, n) 或 span，禁 std::vector / QVector 过界。
               Eigen 只出现在插件作者围栏内侧：Eigen::Map 包装视图，零拷贝。
               MatrixXd 不能别名外部内存，所以输入可借用、输出必走 arena——这个不对称是设计根由",
  layeredProjection: "L0 内置函数（编译期注册，Eigen 原生）→ L1 WASM（沙箱、可中断，
                      受 wasm32 4GB 线性内存硬顶）→ L2 进程外原生（协议 v1，memfd 共享内存零拷贝）。
                      三层实现同一个 FunctionSignature，语义以本文件为准"
}
```

## 已锁定 vs 未决

**已锁定**（改动须新决策记录）：

1. portId / outputId 稳定身份，禁止按位置定位；
2. K 由签名固定，永不由数据决定；
3. 参数与数据分离；
4. ABSENT 是显式缺席，不是空矩阵；
5. 取消 / 进度 / 求值同一入口（禁双接口）；
6. 元数据推、数据拉；输出走 arena；列主序 + `ld`；
7. 结构化错误 code + params。

**未决**（阻塞 `dc_plugin.h` 字节布局冻结；冻结前必须裁决）：

- A. ABSENT 在 C 边界的编码：kind 枚举值 vs 独立 presence 位域；
- B. params 进入 C 边界的形态：JSON 字符串 vs 展开 POD 字段 vs 宿主访问器函数。

## 投影关系

```
本文件（单一事实源）
 ├─► FunctionSignature 注册表 —— C++/TS 同构，内置函数先行注册（stats.ts 五个候选是首批压力测试）
 ├─► dc_plugin.h —— C 投影。未冻结，触发条件见上游决策 §重访触发
 ├─► Rust repr(C) 镜像 —— WASM 层（Rust 无稳定 ABI，repr(C)+extern "C" 是唯一路径）
 └─► 卡片层差分夹具 —— web/tests/fixtures/cards/（照抄 xlayer 裁判模式）
```
