# Token Vault 学习路径

## 第一阶段结业记录（2026-09-26）

项目核心功能、安全测试和最终约束审计已经完成，并已由学习者上传 GitHub。

已完成：

- Rust + Anchor 链上程序
- `initialize_vault`
- `deposit`
- `withdraw`
- VaultState PDA 作为 Vault Token Account 的 Token authority
- 通过 CPI 调用 SPL Token Program
- 用户真实签名与 PDA signer
- PDA seeds、bump、Mint、authority、writable、Token Program 校验
- 正常流程测试与安全失败测试
- Surfpool 本地测试
- 最终权限与约束审计

原始项目目标已经完成。下一阶段是两轮独立重建练习。

## 1. 从需求拆出权限模型

写代码之前先回答：

1. 谁拥有 Token？
2. 谁可以提出 deposit 或 withdraw？
3. 谁是 Vault Token Account 的 Token authority？
4. 哪些账户会被修改？
5. 哪些地址必须唯一且可验证？
6. 哪一步需要真实私钥签名？
7. 哪一步需要 PDA signer？
8. 最终由哪个程序真正修改 Token 余额？

最终设计：

```text
每个 user + mint
        ↓
唯一 VaultState PDA
        ↓
唯一 Vault Token Account PDA
```

VaultState：

```text
runtime owner = Vault Program
保存 owner、mint、bump
同时作为 Vault Token Account 的 Token authority
```

Vault Token Account：

```text
runtime owner   = SPL Token Program
mint            = 当前 Vault 的 mint
Token authority = VaultState PDA
保存真实 Token 余额
```

三个 Instruction：

```text
initialize_vault
deposit
withdraw
```

## 2. 设计两个 PDA

### VaultState PDA

```text
VaultState = PDA(
    当前 Vault Program ID,
    [
        VAULT_STATE_SEED,
        user 公钥,
        mint 公钥
    ]
)
```

作用：

- 把 Vault 绑定到一个用户和一种 Mint。
- 保存项目自己的状态数据。
- 在 withdraw 时充当 Vault Token Account 的 Token authority。
- 使用 seeds 与 bump 获得临时 PDA signer 权限。

### Vault Token Account PDA

```text
VaultTokenAccount = PDA(
    当前 Vault Program ID,
    [
        VAULT_TOKEN_ACCOUNT_SEED,
        VaultState 地址
    ]
)
```

作用：

- 存放真实 Token。
- 保证每个 VaultState 只有一个 canonical Vault Token Account。
- 防止客户端随意传入其他 Token Account 冒充 Vault。

重要认识：PDA 地址本身不会保存 seeds 或 bump。程序需要时必须再次使用相同的 `program_id + seeds + bump` 重建或验证地址。

VaultState 保存 bump 是项目设计选择，因为 withdraw 时需要它成为 PDA signer。Vault Token Account 和 ATA 都不必永久保存 bump；需要验证地址时可以重新派生。

## 3. 实现 initialize_vault

初始化完成：

1. 创建 VaultState。
2. 创建 Vault Token Account。

用户承担两个新账户所需的 lamports：

```rust
payer = user
```

因此 `user` 必须是 signer 和 writable。

初始化后：

```text
VaultState runtime owner         = Vault Program
Vault Token Account runtime owner = SPL Token Program
Vault Token Account authority     = VaultState PDA
```

VaultState 写入：

```text
owner = user 公钥
mint  = mint 公钥
bump  = VaultState canonical bump
```

`system_program` 用于创建和分配新账户，不是 VaultState 创建完成后的 runtime owner。

初始化中的：

```rust
token::mint = mint
token::authority = vault_state
```

是创建 Token Account 的初始化参数，不是普通的重复验证。

## 4. 实现 deposit

```text
用户 Token Account
        ↓
Vault Token Account
```

来源 Token Account 的 authority 是 user，因此 user 必须提供真实签名。

需要 writable：

```text
user_token_account  余额减少
vault_token_account 余额增加
```

CPI 账户关系：

```text
from      = user_token_account
mint      = mint
to        = vault_token_account
authority = user
```

执行过程：

```text
用户钱包签署交易
→ Validator 验证签名
→ Anchor 检查 Signer、PDA 和 Token Account 约束
→ 进入 deposit handler
→ Vault Program CPI 调用 SPL Token Program
→ Token Program 验证 user 的转账权限
→ Token Program 修改两个 Token Account 的余额
```

Vault Program 不能直接修改 Token Account 的 `amount`，因为 Token Account 的 runtime owner 是 SPL Token Program。

## 5. 实现 withdraw

```text
Vault Token Account
        ↓
用户 Token Account
```

withdraw 包含两种授权：

```text
user 真实签名
→ 证明是谁要求提款

VaultState PDA signer
→ 授权 SPL Token Program 从 Vault 扣款
```

用户签名发生在 handler 之前：

```text
客户端钱包签署交易
→ Validator 的 sigverify 验证 Ed25519 签名
→ Runtime 给 user 当前 instruction 的 signer 权限
→ Anchor Signer<'info> 检查 is_signer
→ 其他 Accounts 约束通过
→ 进入 handler
```

PDA signer 在 CPI 时产生：

```text
Vault Program 提交 VaultState seeds 和 bump
→ SVM 使用当前 Vault Program ID 重建 PDA
→ 地址匹配
→ SVM 仅在本次 CPI 中临时授予 signer 权限
→ SPL Token Program 接受 VaultState 的授权
```

CPI 账户关系：

```text
from      = vault_token_account
mint      = mint
to        = user_token_account
authority = vault_state
```

PDA signer seeds：

```text
[
    VAULT_STATE_SEED,
    user 公钥字节,
    mint 公钥字节,
    bump 字节
]
```

PDA 没有私钥，也不会生成 Ed25519 签名。`invoke_signed` 只是让 SVM 验证当前调用程序 ID、seeds 和 bump 能否得到目标 PDA，然后临时授予 signer 权限。

## 6. TypeScript 测试路径

```text
取得测试环境和 Program 客户端
→ 准备 payer 与 user
→ 创建 Mint
→ 创建用户 Token Account
→ mint 测试 Token
→ 计算两个 PDA
→ initialize
→ 查询并验证状态
→ deposit
→ 查询并验证余额
→ withdraw
→ 查询并验证余额
→ 执行安全失败测试
→ 确认失败交易没有改变余额
```

### `anchor.workspace.tokenVault`

`tokenVault` 是 Anchor 根据 workspace 程序名称生成的小驼峰属性。

### `as Program<TokenVault>`

`as` 是 TypeScript 类型断言，只影响静态类型检查，不会在运行时转换对象。

### PublicKey 比较

`PublicKey` 是对象，比较地址内容应使用：

```ts
publicKeyA.equals(publicKeyB)
```

### `bigint` 与 `BN`

SPL Token 的 `getAccount()` 把链上 `u64 amount` 返回为 JavaScript `bigint`：

```ts
20n
```

`n` 表示 `bigint` 类型。Anchor 指令参数使用 `BN`，安全转换方式是：

```ts
new anchor.BN(amount.toString())
```

```text
JavaScript bigint
→ 十进制字符串
→ Anchor BN
```

不要随意先转成 JavaScript `number`，因为大 `u64` 可能超过安全整数范围。

### 捕获交易错误与日志

```ts
let error: unknown = null;

try {
    // 预期失败的交易
} catch (caughtError) {
    error = caughtError;
}
```

错误对象可能带有 Solana 详细执行日志：

```ts
const logs =
    (error as { logs?: string[] }).logs ?? [];
```

合并主错误和日志：

```ts
const evidence = [
    String(error),
    ...logs,
]
    .join("\n")
    .toLowerCase();
```

这样可以在所有错误信息中寻找真正失败原因。

## 7. 安全失败测试

已验证：

1. Bob 冒充 Alice 提款。
2. 收款 Token Account Mint 错误。
3. 收款 Token Account authority 错误。
4. 使用非 canonical Vault Token Account。
5. 提款数量超过 Vault 余额。
6. 每次失败后余额保持不变。

Anchor 验证阶段的典型错误：

```text
错误 VaultState PDA       → ConstraintSeeds
错误 Mint                 → ConstraintTokenMint
错误 Token authority      → ConstraintTokenOwner
错误 Vault Token Account  → ConstraintSeeds
```

超额提款则发生在 SPL Token CPI：

```text
Anchor 约束通过
→ 进入 withdraw handler
→ PDA signer 成功
→ Token Program 发现余额不足
→ insufficient funds
→ 整笔交易回滚
```

## 8. Surfpool 测试与排错

最终使用 Surfpool：

```bash
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost anchor test
```

```text
NO_PROXY / no_proxy
→ 让 localhost 和 127.0.0.1 绕过系统代理

anchor test
→ 构建程序
→ 启动 Surfpool
→ 部署程序
→ 根据 Anchor.toml 执行 TypeScript 测试
```

解决过的问题：

- 系统找不到 Surfpool 可执行文件。
- 系统代理拦截 `127.0.0.1:8899`。
- 旧 Surfpool 进程占用 `8899`。
- Anchor 配置的钱包文件不存在。
- TypeScript 变量大小写拼写错误。
- Node 模块类型警告。

最终结果：

```text
1 passing
```

只有一个 passing，是因为所有正常场景和失败场景目前位于同一个 `it(...)` 中。

## 9. 最终约束审计

约束分为：

```text
A. 独立必要
B. 当前逻辑重复，但提供防御性验证
P. 产品规则
```

必须保留：

- `Signer<'info>`
- `mut`
- 强类型 `Account` / `InterfaceAccount`
- 两组 canonical PDA `seeds + bump`
- 初始化时的 `token::mint` 与 `token::authority`
- 正确 Token Program、System Program、payer 和 space

当前模型中逻辑重复：

```rust
constraint = vault_state.owner == user.key()
has_one = mint
```

因为 VaultState seeds 已包含 user 和 mint，初始化时又把相同数据写入状态，并且之后没有修改路径。

Vault Token Account 的部分 Mint/authority 校验也受到初始化不变量、canonical PDA 和 Token Program 检查覆盖。当前 v1 仍保留它们，以便提前失败、产生清晰错误并防止未来代码破坏不变量。

产品规则：

- deposit 的 `token::authority = user` 表示只允许从用户自己控制的 Token Account 存款；删除后可能允许 delegate 代存。
- withdraw 的 `token::authority = user` 表示只能提款到当前用户控制的 Token Account；删除后代表允许提款给任意同 Mint 收款人。

## 10. 当前形成的核心认识

1. 客户端计算 PDA 只是为了知道传哪个地址；链上每次仍独立验证。
2. Anchor 宏生成验证代码，最终由 Validator 内的 SVM 执行。
3. Solana CLI 是客户端工具，不负责持续执行链上程序。
4. Surfpool 在本地提供 RPC 与 SVM；真实网络由 Validator 承担。
5. `Signer<'info>` 不执行 Ed25519 验签，只检查 Runtime 提供的 `is_signer`。
6. 用户签名认证请求者；PDA signer授权 Vault Token Account 扣款。
7. PDA 只证明地址关系，不自动验证 Token Account 内部数据。
8. runtime owner 与 Token authority 是不同概念。
9. Token Account 的 `amount` 只能由 SPL Token Program 修改。
10. `transfer_checked` 是对 SPL Token Program `TransferChecked` 指令的 CPI 包装。
11. 任意一步失败，整笔交易状态修改都会回滚。
12. 判断约束是否重复，必须结合账户完整生命周期。

## 11. 下一阶段：两轮重建

### 第一轮：在当前项目中重写关键部分

1. 不看现有代码，写出两个 PDA 的派生关系。
2. 写出三个 Instruction 的账户。
3. 标记 signer、writable、runtime owner 和 Token authority。
4. 重写 `initialize_vault` Accounts。
5. 重写 deposit CPI。
6. 重写 withdraw PDA signer 与 CPI。
7. 独立设计至少两个失败测试。
8. 卡住时先写因果链，再查看原代码。

### 第二轮：在干净 Debian 中独立重建

由学习者自己执行 `anchor init`，然后按照：

```text
需求
→ 权限模型
→ Account 与 PDA
→ initialize
→ deposit
→ withdraw
→ 正常测试
→ 安全失败测试
→ 最终审计
```

允许查官方文档，但不直接复制旧项目。

真正完成标准：

```text
能够解释为什么需要每个账户
能够预测删除某个约束会发生什么
能够判断错误发生在哪一层
能够独立调试并完成项目
```
