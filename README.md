# Token Vault — Solana Anchor 学习项目

这是一个使用 Rust、Anchor 和 SPL Token Program 实现的最小但完整的 Token Vault。

每位用户可以针对某个 Mint 创建独立 Vault：

- 用户可以把该 Mint 的 SPL Token 存入 Vault。
- 用户只能从自己的 Vault 提款。
- Vault Token Account 不由用户钱包直接控制。
- VaultState PDA 是 Vault Token Account 的 Token authority。
- deposit 和 withdraw 都通过 CPI 调用 SPL Token Program 的 `TransferChecked` 指令。

> 本项目用于学习和展示 Anchor 权限模型，尚未经过专业安全审计，不建议直接用于主网资金。

## 核心设计

一个 Vault 由两个 PDA 账户组成。

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

它由当前 Vault Program 作为 runtime owner，保存：

```text
owner = 创建 Vault 的用户
mint  = Vault 接受的 Token Mint
bump  = VaultState PDA 的 bump
```

VaultState 还充当 Vault Token Account 内部记录的 Token authority。它没有私钥；withdraw 时，Vault Program 使用相同 seeds 和 bump，通过 `invoke_signed` 让 SVM 临时授予该 PDA signer 权限。

### Vault Token Account PDA

```text
VaultTokenAccount = PDA(
    当前 Vault Program ID,
    [
        VAULT_TOKEN_ACCOUNT_SEED,
        VaultState 公钥
    ]
)
```

它是标准 SPL Token Account：

```text
runtime owner   = SPL Token Program
token mint      = 当前 Vault 的 mint
token authority = VaultState PDA
```

它保存真实 Token 余额。Vault Program 不能直接修改余额；余额只能由 SPL Token Program 按规则修改。

## 账户关系

```text
用户钱包
  │
  │ 签名并支付初始化费用
  ▼
VaultState PDA
  │
  │ 作为 Token authority
  ▼
Vault Token Account PDA
  │
  │ 保存指定 Mint 的 Token
  ▼
SPL Token Program
```

每个 `(user, mint)` 组合对应唯一 VaultState，每个 VaultState 又对应唯一 canonical Vault Token Account。

## Instructions

### `initialize_vault`

创建并初始化 VaultState PDA 和 Vault Token Account PDA。

主要权限与约束：

- `user` 必须是 signer，并支付新账户所需的 lamports。
- VaultState 必须匹配 `[VAULT_STATE_SEED, user, mint]`。
- Vault Token Account 必须匹配 `[VAULT_TOKEN_ACCOUNT_SEED, vault_state]`。
- Vault Token Account 的 Mint 设置为传入的 `mint`。
- Vault Token Account 的 Token authority 设置为 VaultState PDA。
- VaultState 保存 `owner`、`mint` 和 `bump`。

### `deposit`

```text
用户 Token Account
        ↓
Vault Token Account
```

主要权限与约束：

- `user` 必须签名。
- 用户 Token Account 必须由当前 `user` 控制，并使用当前 Mint。
- VaultState 必须由当前 `user` 和 `mint` 派生。
- Vault Token Account 必须是当前 VaultState 对应的 canonical PDA。
- Vault Token Account 的 Mint 必须正确，Token authority 必须是 VaultState。
- 来源和目的 Token Account 都必须 writable。

CPI 的 authority 是用户，因此 SPL Token Program 使用用户在外层交易中的真实签名授权扣款。

### `withdraw`

```text
Vault Token Account
        ↓
用户 Token Account
```

withdraw 包含两层不同授权：

```text
用户签名
→ 证明是谁请求提款

VaultState PDA signer
→ 授权 SPL Token Program 从 Vault Token Account 扣款
```

程序使用：

```text
VAULT_STATE_SEED
+ user 公钥
+ mint 公钥
+ VaultState bump
```

构造 signer seeds，并通过 `CpiContext::new_with_signer` 发起 `TransferChecked` CPI。SVM 重新派生 VaultState PDA，只有地址匹配时才在这一次 CPI 中临时授予 signer 权限。

## 安全模型

本项目不信任客户端传入的账户地址，而是在链上重新验证账户关系。

- `Signer<'info>`：确认对应公钥拥有当前指令的 signer 权限。
- `seeds` 与 `bump`：重新计算 canonical PDA，防止账户替换。
- Mint 校验：防止不同 Token 类型混用。
- Token authority 校验：验证谁有权转出 Token。
- `mut`：声明会发生余额变化的账户必须 writable。
- Token Program 校验：确保 CPI 和 Token Account 属于预期 Token Program。
- 原子回滚：任意 Anchor 验证、PDA signer 或 SPL Token 检查失败，整笔交易都不会提交。

### 防御性重复约束

当前版本有意保留部分由初始化不变量或 `TransferChecked` 再次覆盖的约束，例如：

```text
vault_state.owner == user
vault_state.mint == mint
Vault Token Account 的 mint 与 authority 校验
```

它们让权限边界更容易审计，并能在未来代码破坏初始化不变量时提前失败。极简版本可以在完成完整生命周期证明后同时删除冗余字段与约束，而不应只凭“看起来重复”删除。

## 测试范围

TypeScript 测试覆盖：

- 成功创建 VaultState 和 Vault Token Account。
- VaultState 的 `owner`、`mint` 和 `bump` 正确。
- 正常 deposit 与 withdraw 后余额正确。
- Bob 不能冒充 Alice 提款。
- 错误 Mint 的收款账户被拒绝。
- 正确 Mint、错误 Token authority 的收款账户被拒绝。
- 非 canonical Vault Token Account 被 PDA seeds 拒绝。
- 超过 Vault 实际余额的提款被 SPL Token Program 拒绝。
- 所有失败交易之后，相关余额保持不变。

多个场景目前位于同一个 Mocha `it(...)` 中，因此全部成功时显示：

```text
1 passing
```

这表示该测试中的所有调用和断言均已通过。

## 本地环境

项目面向 WSL2 Debian，主要依赖：

- Rust
- Solana CLI
- Anchor CLI
- Node.js
- Yarn
- Surfpool

## 构建

```bash
anchor build
```

该命令编译 Anchor Program，并生成 IDL 和客户端类型文件。

## 使用 Surfpool 测试

```bash
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost anchor test
```

- `NO_PROXY` 与 `no_proxy` 让本地 RPC 绕过系统代理。
- `anchor test` 构建程序、启动 Surfpool、部署程序并运行 TypeScript 测试。

如果端口 `8899` 已被旧 Surfpool 进程占用，需要先确认并停止对应旧进程。

## 项目学习重点

- 从需求拆分 Account、PDA、Instruction 和权限模型。
- 区分 runtime owner 与 Token authority。
- 理解用户真实签名与 PDA signer 的不同职责。
- 使用 `seeds` 与 `bump` 验证 canonical PDA。
- 使用普通 CPI 和 PDA signer CPI。
- 使用 `TransferChecked` 转移 SPL Token。
- 为正常路径和攻击路径编写测试。
- 判断失败发生在 Anchor 验证、Vault handler 还是 SPL Token CPI。

详细学习过程见 [LEARNING_PATH.md](./LEARNING_PATH.md)，术语说明见 [PROJECT_GLOSSARY.md](./PROJECT_GLOSSARY.md)。

## 当前范围之外

- 关闭 Vault 和退还账户租金。
- Event 与自定义业务错误。
- Token-2022 扩展。
- Devnet/Mainnet 部署。
- 前端界面。
- 专业安全审计。

## 安全提醒

不要提交以下内容：

- `~/.config/solana/id.json`
- 钱包私钥或助记词
- `target/deploy/*-keypair.json`
- 包含密钥的 `.env`
- RPC API Key

如果私钥曾经进入公开 Git 历史，仅从最新版本删除并不安全；应立即停止使用并更换对应 Keypair。
