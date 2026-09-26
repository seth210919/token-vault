# Token Vault 项目术语与配置手册

## 这份文件的用途

这不是项目进度表，而是本项目所有语法、术语、配置和工具行为的可查询说明书。

维护规则：

1. 项目中新出现一个 Rust、Anchor、Solana、Cargo 或 TypeScript 概念时，在这里解释。
2. 不只解释“怎么写”，还解释它验证什么、由谁执行、错了会怎样。
3. 即使是模板默认值或当前暂时用不到的配置，也记录其用途。
4. 不把编译期检查、Anchor 约束检查和 Solana runtime 检查混为一谈。
5. 命令执行前，要说明命令、读写范围、可能生成的文件和副作用；默认由学习者亲自运行。

---

## 一、先区分项目里的检查层级

理解一段 Anchor 代码时，先判断“是谁在检查”。

### 1. Rust 编译器

负责检查：

- Rust 语法是否合法。
- 类型是否匹配。
- lifetime 是否满足要求。
- 模块和名称是否存在。
- 所有权、借用与可变借用是否合法。

Rust 编译通过，不代表链上权限模型安全。

### 2. Anchor 宏生成的账户验证代码

`#[derive(Accounts)]` 和 `#[account(...)]` 会生成账户解析与约束验证代码。

负责检查例如：

- 某账户是否签名。
- 某账户是否 writable。
- PDA seeds 是否匹配。
- 账户 runtime owner 是否正确。
- Token Account 的 mint/authority 是否正确。

### 3. Solana runtime

负责执行交易级规则，例如：

- 没有标记 writable 的账户不能被修改。
- 普通账户不能假冒 transaction signer。
- 程序只能直接修改由自己拥有的账户数据。
- CPI 时 privilege 不能凭空升级。

### 4. SPL Token Program

负责 Token 规则，例如：

- 转出账户的 authority 是否正确签名。
- Token Account 的 Mint 是否适用于该指令。
- 余额是否足够。
- Token Account 是否被冻结。
- 转账金额和 decimals 是否符合 checked transfer 的参数。

### 5. 我们自己的 handler

负责业务状态更新和不能完全由声明式约束表达的业务规则。

原则：能稳定写在 Accounts 约束里的身份关系，优先在那里验证；handler 不应盲信客户端。

---

## 二、Rust 类型语法：`Account<'info, VaultState>` 到底是什么

### 泛型结构

```rust
Account<'info, VaultState>
```

可以拆成：

```text
Account < 'info, VaultState >
  │        │         │
类型名   lifetime   泛型类型参数
```

尖括号 `<...>` 中是传给泛型类型的参数。这里有两个参数：

1. `'info`：lifetime 参数。
2. `VaultState`：账户数据类型参数。

### `Account` 是什么

`Account` 是 Anchor 提供的账户容器，不是 Solana 原始 Account 的简单别名。

它主要做两类工作：

1. 验证传入账户的 runtime owner 是否属于 `VaultState` 声明的 owner。
2. 把账户 data 反序列化成 `VaultState`，让 Rust 可以通过字段访问数据。

所以：

```rust
pub vault_state: Account<'info, VaultState>
```

不只是说“这里传入一个账户”，而是说：

> 这里必须传入一个能被 Anchor 认作 `VaultState` 的账户，并把它解析为可访问的 Rust 数据结构。

### `'info` 是什么

单引号开头的 `'info` 是 Rust lifetime 名称，不是字符串。

它表示 `InitializeVault` 中这些账户引用来自同一批 instruction account infos，并且这些借用不能活得比底层账户信息更久。

```rust
pub struct InitializeVault<'info> {
    pub user: Signer<'info>,
    pub mint: Account<'info, Mint>,
}
```

`'info` 这个名字不是关键字，也可以取别的 lifetime 名称；Anchor 社区惯例使用 `'info`，表示 account info lifetime。

### `VaultState` 放在第二个参数里做什么

它告诉 `Account`：

- 应按什么结构反序列化 data。
- 应期待什么 discriminator。
- 应使用哪种账户 owner 检查逻辑。
- 字段访问时有哪些字段和类型。

因此可以写：

```rust
ctx.accounts.vault_state.owner
```

如果换成：

```rust
Account<'info, Mint>
```

同一个 `Account` 容器就会按 SPL Mint 类型验证和解析，而不是按 `VaultState` 解析。

### `Account` 与链上“账户”这个概念的区别

需要区分：

- 小写概念 account：Solana 传给程序的链上账户。
- Rust 类型 `Account<'info, T>`：Anchor 对某类链上账户的安全包装器。
- `AccountInfo<'info>`：更底层、约束更少的原始账户信息包装。

`AccountInfo` 更自由，也意味着通常需要自己完成更多 owner、data、signer 等验证。不能为了方便随意把强类型 `Account` 换成 `AccountInfo`。

---

## 三、本项目当前使用的账户容器

### `Signer<'info>`

```rust
pub user: Signer<'info>
```

表示该账户必须在当前交易中拥有 signer privilege。

它验证的是“交易中是否签名”，不是“它是否等于 Vault owner”。后者还需要 seeds、地址相等或 `has_one` 等关系约束。

### `Account<'info, VaultState>`

```rust
pub vault_state: Account<'info, VaultState>
```

表示当前程序拥有、带正确 Anchor discriminator、能反序列化为 `VaultState` 的账户。

### `Account<'info, Mint>`

```rust
pub mint: Account<'info, Mint>
```

表示经典 SPL Token Program 拥有、能解析为 Mint 数据的账户。

这里的 `Mint` 来自：

```rust
anchor_spl::token::Mint
```

不是我们自己定义的 Rust struct。

### `Account<'info, TokenAccount>`

```rust
pub vault_token_account: Account<'info, TokenAccount>
```

表示经典 SPL Token Program 拥有、能解析为 Token Account 数据的账户。

Token Account 内部重要字段包括：

- `mint`
- `owner`（在 Token 语境中通常称 token authority）
- `amount`
- delegate/frozen/close authority 等状态

注意：Token Account 数据中的 `owner` 字段和 Solana runtime owner 不是一回事。

```text
Vault Token Account 的 runtime owner = SPL Token Program
Vault Token Account 数据里的 owner/token authority = VaultState PDA
```

### `Program<'info, Token>`

```rust
pub token_program: Program<'info, Token>
```

表示传入账户必须：

- 是 executable program。
- 地址等于经典 SPL Token Program ID。

`Token` 是 Anchor SPL 中代表经典 Token Program 的标记类型。

### `Program<'info, System>`

```rust
pub system_program: Program<'info, System>
```

表示传入账户必须是 Solana System Program。

创建普通账户、分配空间、转移用于 rent 的 lamports、指定初始 runtime owner 时需要它。

### 后续可能见到的容器

#### `InterfaceAccount<'info, T>`

可以接受由多个兼容程序拥有的同类账户。例如 Token Program 和 Token-2022 Program 的基础 Mint/Token Account。

本项目第一版刻意不用它，因为我们只允许经典 SPL Token Program。

#### `Interface<'info, T>`

程序接口容器，可以接受一组声明为兼容接口的 program IDs。本项目当前不用。

#### `UncheckedAccount<'info>`

Anchor 不替你完成特定数据类型的 owner/反序列化检查。使用时必须在安全注释和代码中解释为何安全。

#### `SystemAccount<'info>`

验证账户由 System Program 拥有，但不要求它必须签名。

---

## 四、Anchor 属性与派生宏

### `#[account]`

```rust
#[account]
pub struct VaultState { ... }
```

这是附加给状态 struct 的 Anchor attribute macro。它使该类型具备 Anchor 账户所需的序列化、反序列化、owner 和 discriminator 行为。

它和 Accounts struct 字段上的：

```rust
#[account(mut, seeds = [...], bump)]
```

写法相似，但用途不同：

- 状态 struct 上的 `#[account]`：声明一种 Anchor account data 类型。
- Accounts 字段上的 `#[account(...)]`：声明这个 instruction 对传入账户的约束。

### `#[derive(InitSpace)]`

让 Anchor 根据字段类型计算初始化账户数据所需的字节数，产生：

```rust
VaultState::INIT_SPACE
```

本项目：

```text
owner Pubkey = 32 bytes
mint Pubkey  = 32 bytes
bump u8      = 1 byte
INIT_SPACE   = 65 bytes
```

`INIT_SPACE` 不包含 8-byte Anchor discriminator，所以初始化时写：

```rust
space = 8 + VaultState::INIT_SPACE
```

### `#[derive(Accounts)]`

```rust
#[derive(Accounts)]
pub struct InitializeVault<'info> { ... }
```

它让 Anchor 根据字段类型、字段顺序和 `#[account(...)]` 约束生成 instruction 进入 handler 前的账户验证代码。

如果这里验证失败，handler 不会开始执行。

### `#[program]`

标记程序的 instruction 入口模块。模块里的 public function 会成为客户端可调用的 Anchor instructions，并进入 IDL。

当前模块为空，表示尚未暴露 instruction。

### `#[constant]`

把常量标记为 Anchor 常量，使其可以进入生成信息并被客户端使用。它不负责 PDA 验证；真正验证 seeds 的是 Accounts 约束。

---

## 五、当前 `#[account(...)]` 约束词典

### `mut`

要求账户在交易中具有 writable privilege。

使用场景：

- 修改账户 data。
- 修改 lamports。
- Token 余额会变化。

`mut` 只允许修改，不代表调用者有业务权限；仍需 signer、owner、authority 等检查。

### `init`

让 Anchor 创建并初始化新账户。通常隐含新账户 writable，并要求同时提供：

- `payer`
- 对普通程序状态给出 `space`
- `system_program`

对于 Token Account，还需要 Token Program 和 token 初始化约束。

它不是“如果不存在就创建”；目标已存在或已占用时会失败。

### `payer = user`

指定谁支付创建账户所需的 lamports。payer 必须 signer 且 writable。

### `space = ...`

指定账户 data 分配多少字节。过小会无法序列化，过大通常只是多付 rent 并浪费空间。

### `seeds = [...]`

声明该账户地址必须由当前 program ID 和给出的 seed 列表派生。

seed 的顺序是地址规则的一部分：

```text
[b"vault", user, mint]
```

与：

```text
[b"vault", mint, user]
```

派生出不同地址。

### `bump`

要求 Anchor 使用/验证这组 seeds 的 canonical bump。

bump 是一个 `u8`，用于把 PDA 派生结果调整到 ed25519 曲线之外，从而确保它没有普通私钥，只能由对应程序通过 signer seeds 签名。

### `token::mint = mint`

初始化或验证 Token Account 的 mint 字段等于指定 Mint 账户地址。

### `token::authority = vault_state`

初始化或验证 Token Account 数据里的 authority/owner 字段等于 `vault_state` 地址。

### `token::token_program = token_program`

指定由哪个 Token Program 执行 Token Account 初始化/验证逻辑。本项目再配合 `Program<Token>`，把它限定为经典 SPL Token Program。

---

## 六、PDA、seeds、bump 与 signer seeds

### PDA 地址由什么决定

```text
PDA = function(program_id, ordered_seeds, bump)
```

任一项不同，地址通常都不同：

- program ID
- seed 内容
- seed 顺序
- bump

### canonical bump

PDA 搜索通常从 255 向下寻找第一个能生成有效 PDA 的 bump。这个第一个可用值称 canonical bump。

使用 Anchor 的裸 `bump` 约束时，应让 Anchor验证 canonical bump，而不是相信客户端随意提供一个 bump。

### 地址验证和 CPI 签名不是同一时刻

Accounts 约束中的：

```rust
seeds = [...],
bump
```

用于 instruction 入口时验证 PDA 地址。

withdraw CPI 中的 signer seeds 用于让 Solana runtime 在这次 CPI 中把 PDA视为签名者。

两者必须采用完全相同的 program ID、seed 顺序、seed bytes 和 bump。

### PDA 没有私钥

“PDA 签名”不是找到或保存了 PDA 私钥。是当前程序向 runtime 提供正确 signer seeds，runtime 重新派生并确认该 PDA 属于正在执行的程序，然后为 CPI 授予 signer privilege。

---

## 七、IDL 是什么

IDL 是 Interface Description Language 文件，可以理解为 Anchor 程序对客户端公开的结构化接口说明。

它通常描述：

- program address。
- instructions 名称。
- 每个 instruction 的参数。
- 每个 instruction 需要哪些账户。
- 哪些账户 signer/writable。
- 自定义 account types。
- 自定义 errors。
- events 和 constants（取决于定义与版本）。

### IDL 不是什么

- 它不是链上程序本身。
- 它不替代 runtime 安全检查。
- 修改 IDL 不会自动修改已部署程序。
- 客户端可以不用 IDL 手工构造 instruction，所以程序绝不能把“客户端按 IDL 调用”当成安全边界。

### IDL 如何产生

Anchor 根据 `#[program]`、`#[derive(Accounts)]`、账户类型等信息在构建流程中生成 IDL。

通常生成到项目的 `target/idl/`，对应的 TypeScript 类型通常生成到 `target/types/`。这些目录在我们实际运行构建命令前可能不存在或内容未更新。

### 为什么 TypeScript 测试导入生成类型

后续可能看到：

```typescript
import { TokenVault } from "../target/types/token_vault";
```

这里导入的是根据 IDL 生成的客户端类型，不是导入 Rust 程序。

---

## 八、Cargo、crate、package、workspace

### Cargo

Rust 的包管理与构建工具。负责读取 `Cargo.toml`、解析依赖、调用编译器并管理 feature/profile/workspace。

### crate

Rust 的编译单元。本项目的链上程序 crate 名称是 `token_vault`。

### package

由一个 `Cargo.toml` 描述的发布/构建单位。package 名称可以含连字符，例如 `token-vault`；Rust crate 名通常使用下划线 `token_vault`。

### workspace

把多个 Rust packages 组织在一起，共享依赖解析、target 输出和部分配置。Anchor 项目根目录的 `Cargo.toml` 是 workspace manifest；程序目录里的 `Cargo.toml` 是 program package manifest。

---

## 九、程序 `Cargo.toml` 逐行解释

文件位置：

```text
programs/token-vault/Cargo.toml
```

### `[package]`

开始 package 元数据表。

```toml
name = "token-vault"
```

Cargo package 名称。用于 workspace、依赖和构建信息。

```toml
version = "0.1.0"
```

package 的语义版本。它不等于链上 program ID，也不会自动给已部署程序做升级管理。

```toml
description = "Created with Anchor"
```

人类可读描述。主要用于包元数据，不影响链上行为。

```toml
edition.workspace = true
```

不在当前文件重复写 Rust edition，而是从 workspace 根 `Cargo.toml` 的 `[workspace.package]` 继承。

Rust edition 控制语言解析规则和部分兼容行为，不等同于 rustc 版本。

```toml
rust-version.workspace = true
```

从 workspace 继承最低支持 Rust 版本声明。它帮助 Cargo 判断当前 toolchain 是否满足 package 的 MSRV 要求。

### `[lib]`

配置这个 package 的 library target。

```toml
crate-type = ["cdylib", "lib"]
```

请求生成两类 library 输出：

- `cdylib`：适合产生供 Solana/部署工具链处理的动态风格产物。
- `lib`：普通 Rust library，供测试、IDL、其他 Rust 代码或工具使用。

这不表示 Solana 链上最终运行普通操作系统动态库；SBF 构建工具链会进一步产生链上部署产物。

```toml
name = "token_vault"
```

Rust library crate 名称。Rust 标识符不能像 package 名那样直接使用连字符，所以这里是下划线。

### `[features]`

Cargo features 是条件编译开关。它们不会在运行时动态切换；构建时启用哪些 feature，会决定编译哪些代码路径。

```toml
default = []
```

默认不自动启用额外 features。

```toml
cpi = ["no-entrypoint"]
```

启用 `cpi` feature 时，同时启用 `no-entrypoint`。通常用于把这个程序作为依赖，从其他 Rust/Anchor 程序发起 CPI，而不是构建它自己的入口点。

```toml
no-entrypoint = []
```

声明一个名为 `no-entrypoint` 的 feature。启用时 Anchor 可省略程序入口点，适合以库/CPI 客户端方式依赖。

```toml
no-log-ix-name = []
```

启用时省略 instruction 名称日志，可减少部分日志/计算开销，但调试可读性下降。本项目当前不启用。

```toml
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
```

启用本 package 的 `idl-build` 时，同时启用两个依赖的 IDL 构建支持，让 Anchor 能为程序和 SPL 相关类型生成接口描述。

```toml
anchor-debug = []
```

Anchor 调试相关条件编译 feature。通常由工具链在需要调试检查时使用，默认不开。

```toml
custom-heap = []
custom-panic = []
```

控制是否由程序提供自定义 heap/panic 处理路径。这些是 Solana 程序构建模板需要协调的底层 feature。当前为空且默认不开，不代表“没有 heap/panic 行为”，而是未选择自定义替代实现。

### `[dependencies]`

列出编译这个 program crate 所需的 Rust crates。

```toml
anchor-lang = "1.1.2"
```

Anchor 核心框架：账户容器、宏、Context、错误、序列化和程序入口等。

```toml
anchor-spl = "1.1.2"
```

Anchor 对 SPL programs 的类型与 CPI 封装。本项目用它访问经典 SPL Token Program。

版本字符串 `"1.1.2"` 在 Cargo 中通常是 caret requirement 的简写，不一定表示只允许精确的 `1.1.2`；实际解析版本由 Cargo 的版本规则和 `Cargo.lock` 共同决定。若要精确锁死依赖语义，需要进一步理解 lockfile 和 `=1.1.2` 写法，后续单列说明。

### `[lints.rust]`

配置 rustc lint 行为。

```toml
unexpected_cfgs = {
    level = "warn",
    check-cfg = ['cfg(target_os, values("solana"))']
}
```

它把未知/未声明的 `cfg` 条件检查设为 warning，并告诉 rustc：代码或依赖中出现 `target_os = "solana"` 是预期值。

目的主要是协调普通 Rust 编译环境与 Solana 目标条件编译，减少无意义的 `unexpected_cfgs` 警告，同时仍保留其他意外 cfg 的提示。

`warn` 表示产生警告但通常不因此停止编译；`deny` 才会把对应 lint 当错误。

---

## 十、根 `Cargo.toml` 与其他配置文件

根 `Cargo.toml` 是 workspace 级配置，和程序目录的 `Cargo.toml` 作用不同。为了遵守“不在未授权情况下运行读取命令”的规则，本节不凭记忆猜测当前文件的逐行内容。

后续由学习者打开或粘贴该文件内容后，本手册将补全：

- `[workspace]`
- members/exclude/resolver
- `[workspace.package]`
- release profiles
- overflow checks、LTO、codegen units
- 当前模板实际存在的每一行

同样需要逐行补充的项目文件：

- `Anchor.toml`
- `rust-toolchain.toml`
- `package.json`
- `tsconfig.json`
- `.gitignore`
- `.prettierignore`

原则：只解释当前文件实际内容，不把其他版本模板的配置假装成本项目配置。

---

## 十一、当前 Rust 模块语法

### `pub mod instructions;`

声明并公开 `instructions` 模块。Rust 会按模块规则寻找 `instructions.rs` 或 `instructions/mod.rs`。

### `pub mod initialize_vault;`

在 `instructions.rs` 中声明子模块，对应 `instructions/initialize_vault.rs`。

### `pub use initialize_vault::*;`

把该模块中 public 的名称重新导出到当前模块，调用方不用写完整深层路径。

星号 `*` 表示导入该模块所有可见的 public items。它很方便，但项目变大后可能造成名称来源不够直观，需要权衡。

### `use crate::{...};`

`crate` 表示当前 Rust crate 的根。花括号一次导入同一路径下的多个名称。

### `pub struct InitializeVault<'info>`

- `pub`：其他模块可见。
- `struct`：定义结构体。
- `InitializeVault`：类型名，Rust 类型通常用 PascalCase。
- `<'info>`：声明一个 lifetime 泛型参数。

### `pub field: Type`

例如：

```rust
pub user: Signer<'info>
```

- `pub`：字段对其他模块可见。
- `user`：字段名。
- `:`：左侧是名称，右侧是类型。
- `Signer<'info>`：字段类型。

### `&[u8]`

```rust
pub const VAULT_STATE_SEED: &[u8] = b"vault";
```

- `&`：引用。
- `[u8]`：一段连续 `u8` 字节的 slice，长度不写进类型。
- `b"vault"`：字节字符串字面量，类型接近固定长度字节数组引用使用场景。

PDA seeds 最终需要字节序列，所以使用 bytes，不使用普通 UTF-8 `&str` 类型直接参与派生。

---

## 十二、命令与电脑可控性规则

### 默认规则

Codex 不主动运行 shell 命令。文件修改也必须明确说明修改范围。

### 如果后续需要一条命令，先解释四件事

1. 命令的每个参数是什么。
2. 它会读取哪些路径或配置。
3. 它可能写入、生成或修改哪些文件。
4. 它是否可能访问网络、安装软件、启动 validator 或发送交易。

### 常见副作用分类

#### 只读类

例如版本查询、查看配置。一般不应修改项目，但某些工具即使查询版本也可能做自更新、缓存或迁移，所以仍需说明具体工具风险。

#### 构建类

可能生成：

- `target/`
- IDL
- TypeScript types
- 编译缓存
- SBF program artifacts

#### 包安装类

可能访问网络并修改：

- `node_modules/`
- `yarn.lock` / 其他 lockfile
- Cargo registry/git cache
- `Cargo.lock`

#### 测试类

可能：

- 启动 local validator。
- 创建临时 ledger。
- 构建程序。
- 部署到 localnet。
- 使用配置中的 wallet keypair 作为测试 payer。
- 写入测试日志和 target artifacts。

在运行前必须确认测试目标是 localnet，不能误向 mainnet 发送交易。

---

## 十三、待补全索引

随着项目继续，至少补充：

- `Context<InitializeVault>` 的每层含义。
- `ctx.accounts` 与 `ctx.bumps`。
- `Result<()>`、`Ok(())` 和 `?`。
- instruction discriminator。
- CPI 与 `CpiContext`。
- `new` 与 `new_with_signer`。
- signer seeds 的嵌套 slice 类型。
- `transfer_checked` 的 accounts 和 decimals。
- `has_one`、`constraint`、`address` 等安全约束。
- TypeScript 的 import、describe、it、async/await、Promise。
- PDA 的客户端派生和链上派生如何保持一致。
- IDL 生成类型和 `.accounts(...)` 客户端映射。
- 所有项目配置文件逐行说明。

---

## 十四、Handler、`Context` 与返回值

### Program instruction 入口

```rust
pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
    instructions::initialize_vault::handle_initialize_vault(ctx)
}
```

`#[program]` 模块中的 public function 是 Anchor 暴露给客户端的 instruction 入口。

入口没有直接写业务逻辑，而是把 `ctx` 转交给 instruction 模块中的 handler。这样 `lib.rs` 只负责列出公开接口，具体实现按 instruction 分文件保存。

这是一种代码组织方式，不是 Solana runtime 强制要求。也可以直接把逻辑写在入口函数里，但项目变大后较难维护。

### `Context<InitializeVault>`

`Context` 是 Anchor 提供的泛型上下文类型：

```text
Context < InitializeVault >
   │             │
容器类型      本 instruction 的 Accounts 类型
```

它把本次 instruction 已解析的账户、PDA bumps 等执行上下文交给 handler。

在 handler 开始前，Anchor 已根据 `InitializeVault` 完成账户类型和 `#[account(...)]` 约束验证。如果验证失败，handler 不会执行。

### `ctx.accounts`

```rust
ctx.accounts.user
ctx.accounts.mint
ctx.accounts.vault_state
```

`accounts` 是 `Context` 中经过 Anchor 验证和解析的 Accounts struct。字段名称来自我们定义的 `InitializeVault`。

### `.key()`

Anchor 账户容器的 `.key()` 返回该链上账户的 `Pubkey`：

```rust
ctx.accounts.user.key()
ctx.accounts.mint.key()
```

它取的是账户地址，不是账户内部 data，也不是私钥。

### `ctx.bumps`

当 Accounts struct 中存在带 `bump` 的 PDA 约束时，Anchor 会把验证得到的 bumps 放进本 instruction 对应的 bumps struct。

```rust
ctx.bumps.vault_state
```

返回 `vault_state` PDA 的 canonical bump，类型为 `u8`。

这里不让客户端把 bump 当 instruction 参数传进来。Anchor 已用 seeds 验证 PDA，并把验证结果交给 handler，减少信任客户端输入的机会。

`ctx.bumps` 中也会有 `vault_token_account` 的 bump，但当前状态不保存它，因为后续 withdraw CPI 需要作为 authority 签名的是 `vault_state`。

### 三次状态赋值

```rust
ctx.accounts.vault_state.owner = ctx.accounts.user.key();
ctx.accounts.vault_state.mint = ctx.accounts.mint.key();
ctx.accounts.vault_state.bump = ctx.bumps.vault_state;
```

左侧是新创建的 `VaultState` 账户数据字段；右侧全部来自已经通过 Accounts 验证的上下文。

- `owner` 来自必须签名的 `user` 地址。
- `mint` 来自经典 SPL Token Program 拥有的 Mint 账户地址。
- `bump` 来自 Anchor 对 VaultState seeds 的 canonical bump 验证。

### `Result<()>`

Rust 的 `Result<T, E>` 表示函数可能成功或失败。Anchor prelude 中的 `Result<T>` 是 Anchor 错误类型已确定后的简写，因此只写成功类型 `T`。

这里：

```rust
Result<()>
```

成功值类型是 unit `()`，意思是 instruction 成功时不返回额外业务数据。链上状态变化和日志并不等于 Rust 函数返回数据。

### `Ok(())`

```rust
Ok(())
```

构造一个成功的 `Result`：

- `Ok(...)` 表示成功分支。
- 内层 `()` 是 unit 值。
- 分号不写在最后一个表达式后，使它成为函数返回值。

如果账户约束、账户创建或 handler 执行失败，交易中的状态修改会整体回滚，不会留下只初始化一半的 Vault。

---

## 十五、关系约束：`has_one` 与 `constraint`

### `has_one = field_name`

`has_one` 读取当前 Anchor 状态账户中名为 `field_name` 的 `Pubkey` 字段，并检查它等于 Accounts struct 中同名账户的地址。

例如：

```rust
has_one = mint
```

要求：

```text
vault_state.mint == mint.key()
```

注意：`has_one = owner` 会寻找一个名叫 `owner` 的账户字段，而不会自动理解名为 `user` 的账户就是 owner。

### `constraint = ...`

执行一个返回布尔值的自定义约束。例如：

```rust
constraint = vault_state.owner == user.key()
```

要求状态中保存的 owner 等于本次 signer 的地址。

本项目不用 `has_one = owner`，因为 Accounts 中的签名账户名为 `user`。如果只为了满足 `has_one` 的同名规则而再传一次相同地址的 `owner` 账户，会增加不必要的 instruction account。因此 owner 关系使用 `constraint`；Mint 的账户名与状态字段同名，所以 Mint 关系使用 `has_one = mint`。

Deposit 同时保留 PDA seeds 验证与状态字段关系验证。当前实现中后两条属于重复不变量检查，但它们可以在未来代码意外修改 `owner` 或 `mint` 时尽早拒绝不一致状态。

`constraint` 比专用约束更自由，因此必须明确检查表达式两边分别是什么；写错表达式可能导致约束失效或验证错误关系。

---

## 十六、Deposit CPI 与 `transfer_checked`

### CPI

CPI（Cross-Program Invocation）表示一个链上程序在执行过程中调用另一个链上程序。

Deposit 中的调用链：

```text
客户端 → Token Vault Program → SPL Token Program
```

Token Vault Program 不直接修改 Token Account 的余额，因为 Token Account 的 runtime owner 是 SPL Token Program。

### `TransferChecked`

```rust
let cpi_accounts = TransferChecked {
    from: ...,
    mint: ...,
    to: ...,
    authority: ...,
};
```

这是 `anchor-spl` 对经典 Token Program checked transfer 所需账户集合的 Rust 表示：

- `from`：余额被扣减的 Token Account。
- `mint`：该 Token 的 Mint Account。
- `to`：余额增加的 Token Account。
- `authority`：有权从 `from` 扣款的 signer。

### `.to_account_info()`

Anchor 的强类型账户容器便于验证和访问字段；构造 CPI 时，被调用程序最终需要底层 `AccountInfo`。`.to_account_info()` 取得该底层账户信息，包含地址、owner、lamports、data、signer/writable privileges 等运行时信息。

它不会复制或创建一个新的链上账户，也不会取得私钥。

### `CpiContext::new`

```rust
CpiContext::new(token_program.key(), cpi_accounts)
```

把两部分组合起来：

1. 调用哪个目标程序的 `Pubkey`。
2. 给目标 instruction 传哪些账户。

本项目使用 Anchor 1.1.2；该版本的 `CpiContext::new` 第一个参数要求 `Pubkey`，不是 `AccountInfo`。因此这里调用 `.key()`，而不是 `.to_account_info()`。

Deposit 的 authority 是真实签名用户，因此使用 `CpiContext::new`，不需要 PDA signer seeds。

Withdraw 的 authority 将是 PDA，届时才使用带 signer seeds 的 `new_with_signer`。

### `transfer_checked`

```rust
token::transfer_checked(cpi_context, amount, mint.decimals)
```

向经典 SPL Token Program 发起 checked transfer CPI。

- `amount`：以最小单位表示的整数数量，类型为 `u64`。
- `mint.decimals`：从已经验证的 Mint Account data 中读取 decimals。

相比不携带 Mint/decimals 的普通 transfer，checked transfer 让 Token Program 同时验证 Mint 和 decimals，减少客户端或调用程序对币种精度理解错误的风险。

### Handler 直接返回 CPI Result

`token::transfer_checked(...)` 本身返回 `Result<()>`。它是 handler 的最后一个表达式，因此 handler 直接把 CPI 的成功或失败返回给 program 入口，无需再写 `?; Ok(())`。

---

## 十七、TypeScript 集成测试骨架

### JavaScript、TypeScript 与 Node.js

- JavaScript：语言。
- TypeScript：在 JavaScript 上增加静态类型检查的语言；测试运行前由工具转换/解释为 JavaScript 执行语义。
- Node.js：在浏览器外运行 JavaScript 的运行时，本项目用它执行测试客户端。
- Mocha：测试框架，提供 `describe`、`it` 等测试组织函数。
- ts-mocha：让 Mocha 能执行 TypeScript 测试文件的工具。

链上程序仍是 Rust/SBF；TypeScript 文件只是链下客户端，用来构造并发送测试交易、读取账户和断言结果。

### `import * as anchor from "@anchor-lang/core"`

```typescript
import * as anchor from "@anchor-lang/core";
```

从安装在 `node_modules` 中的 `@anchor-lang/core` package 导入所有公开导出，并把它们放到本文件名为 `anchor` 的命名空间对象下。

因此后面写：

```typescript
anchor.AnchorProvider
anchor.workspace
anchor.setProvider
```

字符串 `"@anchor-lang/core"` 是 package 名，不是本地相对文件路径。

### 命名导入 `import { Program }`

```typescript
import { Program } from "@anchor-lang/core";
```

只把 package 中名为 `Program` 的导出直接引入当前文件，因此可以写 `Program<...>`，不必写 `anchor.Program<...>`。

这里主要把 `Program` 用作 TypeScript 类型。

### 相对路径导入生成类型

```typescript
import { TokenVault } from "../target/types/token_vault";
```

- `..`：从 `tests/` 返回项目根目录。
- `target/types/token_vault`：Anchor build 根据 IDL 生成的 TypeScript 类型文件。
- `TokenVault`：描述本程序 instructions、accounts 和参数的类型。

它不是导入链上 `.so` 文件，也不是部署程序。

### `describe`

```typescript
describe("token-vault", () => {
    // 测试套件内容
});
```

`describe` 由 Mocha 在测试运行环境中提供，用于把一组相关 tests 组织为一个测试套件。

- 第一个参数 `"token-vault"` 是测试套件名称。
- 第二个参数是一个函数；Mocha 调用它来登记该套件中的测试。

### 箭头函数 `() => {}`

```typescript
() => {
}
```

这是 JavaScript/TypeScript 的箭头函数语法。

- `()`：参数列表为空。
- `=>`：把参数与函数体连接起来。
- `{}`：函数体。

大致对应 Rust 中不捕获参数的 closure：

```rust
|| {
}
```

两种语言的 closure 规则并不完全相同，这里只作形状类比。

### `const`

```typescript
const provider = ...;
```

声明一个不能被重新赋值的变量绑定。它不意味着对象内部永远不可变，只表示不能再执行 `provider = 另一个值`。

可粗略类比 Rust 的默认不可重新赋值 `let`，但两种语言的所有权和可变性模型不同。

### `AnchorProvider.env()`

```typescript
const provider = anchor.AnchorProvider.env();
```

根据进程环境构造 Anchor provider。Provider 是测试客户端与 Solana 集群交互所需信息的组合，核心包括：

- RPC connection：向哪个集群查询和发送交易。
- wallet：默认由谁支付交易费并签名。
- confirmation options：如何确认交易。

在 Anchor 测试流程中，相关环境变量通常由 Anchor CLI 根据 `Anchor.toml` 和测试环境准备。Provider 不是链上账户，也不会因为这一行代码就发送交易。

### `anchor.setProvider(provider)`

把该 provider 设置成当前 Anchor TypeScript 客户端的默认 provider，使后续 workspace program client 使用同一 RPC 和 wallet。

这行只设置客户端状态，本身不发送交易。

### `anchor.workspace.tokenVault`

`anchor.workspace` 根据 workspace 的 IDL 和 provider 提供 program clients。

```typescript
anchor.workspace.tokenVault
```

取得名为 `tokenVault` 的程序客户端。Rust/IDL 名称中的下划线形式会映射到客户端使用的 camelCase 名称。

Program client 用于：

- 构造 instruction。
- 指定 accounts。
- 发送 RPC transaction。
- 读取 Anchor accounts。

仅取得 client 不会调用或部署链上程序。

### `as Program<TokenVault>`

```typescript
const program = anchor.workspace.tokenVault as Program<TokenVault>;
```

`as` 是 TypeScript 类型断言，告诉类型检查器：把左侧值按 `Program<TokenVault>` 看待。

- `Program`：Anchor program client 的泛型类型。
- `<TokenVault>`：该 client 对应本项目生成的 IDL 类型。

这样编辑器和 TypeScript 编译器才能知道 `program.methods` 下有哪些 instruction、参数类型和账户名称。

类型断言主要影响编译期类型理解，不会在运行时自动验证远端 program 真正等于该类型；实际 client 数据来自 workspace/IDL。

### 分号 `;`

JavaScript 在很多位置可以自动插入分号，但本项目格式统一显式写分号，减少某些换行组合造成的歧义。

### `it`

```typescript
it("reads the test wallet address", async () => {
    // 一条测试用例
});
```

`it` 由 Mocha 提供，用于声明一条具体测试用例。

- 第一个参数是测试名称。
- 第二个参数是测试函数。

`describe` 组织一组测试；`it` 表示其中一个具体行为。

### `async`

```typescript
async () => {
}
```

`async` 标记异步函数。异步函数总是返回 Promise；函数内部可以使用 `await` 等待 RPC、交易确认等异步操作。

当前第一条测试没有真正的异步操作，但先使用 `async`，因为后续创建 Mint、发送交易和读取账户都需要 `await`。

### 属性访问

```typescript
provider.wallet.publicKey
```

通过点号逐层读取对象属性：

```text
provider
└── wallet
    └── publicKey
```

这里没有圆括号，所以 `publicKey` 是读取属性，不是调用函数。

### 方法调用

```typescript
user.toBase58()
```

- `user`：PublicKey 对象。
- `.toBase58`：该对象的方法。
- `()`：调用该方法。

它把公钥转换成人类常见的 Base58 字符串，只影响显示，不修改公钥或链上状态。

### `console.log`

```typescript
console.log("Test wallet:", user.toBase58());
```

调用 Node.js/JavaScript 环境的控制台输出方法。这里传入两个参数，控制台会把标签和公钥字符串输出到终端。

它不是 Solana program log，也不会写入交易日志或链上数据。

---

## 十八、`package.json` 依赖与版本范围

### `dependencies`

```json
"dependencies": {
  "@anchor-lang/core": "^1.1.2",
  "@solana/spl-token": "^0.4.14"
}
```

`dependencies` 声明项目在正常运行代码时需要的 JavaScript packages。

- `@anchor-lang/core`：Anchor TypeScript 客户端。
- `@solana/spl-token`：经典 SPL Token 的 JavaScript 客户端工具，测试中用于创建 Mint、创建 Token Account、mint 和读取余额。

链上 Rust 的 `anchor-spl` 与链下 TypeScript 的 `@solana/spl-token` 是两个不同生态中的 packages；名字相近但不能相互替代。

### JSON 逗号规则

JSON 对象的相邻字段之间必须有逗号：

```json
"first": "value",
"second": "value"
```

最后一个字段后通常不允许 trailing comma。JSON 比 JavaScript object literal 的语法更严格，也不允许普通注释。

### `^0.4.14`

`^` 表示兼容版本范围，不是精确锁死。

对于主版本为 `0` 的 `^0.4.14`，包管理器通常允许解析 `0.4.x` 中不低于 `0.4.14` 的兼容版本，但不会自动跨到 `0.5.0`。

实际安装的精确版本由 Yarn 解析后记录在 `yarn.lock`。`package.json` 表达允许范围，`yarn.lock` 记录当前项目解析出的精确依赖树。

### 只修改 `package.json` 尚未完成安装

在运行包管理器前：

- `node_modules` 中可能还没有该 package。
- `yarn.lock` 尚未记录它的精确版本和间接依赖。
- TypeScript 代码此时不能可靠导入该 package。

因此声明依赖与安装依赖是两个不同步骤。

### Peer dependency

Peer dependency 表示一个 package 需要使用方在顶层项目中提供兼容版本的另一个 package。

本项目中：

```text
@solana/spl-token
    └── 需要项目提供兼容的 @solana/web3.js
```

这样 Anchor 客户端和 SPL Token 客户端可以共享项目明确选择的 web3.js 版本，而不是各自隐藏一套可能不同的核心类型。

`fastestsmallesttextencoderdecoder` 是间接依赖使用的文本编码兼容工具，不属于 Token Vault 的业务逻辑；显式声明它是为了满足当前依赖树报告的 peer requirement。

---

## 十九、TypeScript 创建测试 Mint

### 从 SPL Token package 导入函数

```typescript
import { createMint } from "@solana/spl-token";
```

命名导入 `createMint` 函数。该函数是链下客户端封装；调用它会构造、签名并发送创建/初始化 Mint Account 所需的交易。

### 大写常量命名

```typescript
const TOKEN_DECIMALS = 6;
```

语法上只是普通 `const`。全大写加下划线是“不会改变的配置常量”的命名惯例，不是 TypeScript 强制规则。

它位于 `describe` 外，因此是当前模块级常量，可被本文件后续测试代码使用。

### 类型断言取得 payer Keypair

```typescript
const payer = (provider.wallet as anchor.Wallet).payer;
```

圆括号先把 `provider.wallet` 按 Anchor 的具体 `Wallet` 类型看待，再读取 `.payer`。

- `provider.wallet.publicKey`：公开地址。
- `provider.wallet.payer`：测试钱包在本地持有的 Keypair signer，可为创建账户的交易签名。

`payer` 只存在于链下测试环境；绝不能把真实私钥写进源代码或提交到 Git。

### `await`

```typescript
const mint = await createMint(...);
```

`createMint` 返回 Promise，因为创建 Mint 需要发送交易并等待确认。`await` 暂停当前 async 测试函数，直到 Promise：

- 成功：得到新 Mint 的 `PublicKey`，赋给 `mint`。
- 失败：抛出错误，Mocha 将该测试判定失败。

它只暂停当前异步函数，不会阻塞整个 Solana 集群。

### `createMint` 参数顺序

```typescript
createMint(
  provider.connection,
  payer,
  user,
  null,
  TOKEN_DECIMALS
)
```

参数按位置匹配，顺序不能随意交换：

1. `provider.connection`：发送交易和查询状态的 RPC connection。
2. `payer`：支付创建 Mint Account 所需 lamports 和交易费的 Keypair signer。
3. `user`：新 Mint 的 mint authority；测试钱包以后可以增发测试 Token。
4. `null`：不设置 freeze authority。
5. `TOKEN_DECIMALS`：Mint decimals，本项目测试设为 6。

这里的 `null` 是 JavaScript/TypeScript 的明确空值，表示该可选 authority 不存在；它不是 Rust 的 `None`，但在这个 API 参数中的业务含义类似。

`createMint` 返回的是新 Mint Account 的 `PublicKey`，不是整个 Mint data，也不是 Mint authority 的私钥。

---

## 二十、TypeScript 创建用户 ATA

### 多个命名导入

```typescript
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
```

花括号中可以从同一 package 导入多个具名导出。换行只是为了可读性，不改变语义。

末尾逗号是 TypeScript/JavaScript 模块语法允许的 trailing comma，便于以后继续添加导入并减少版本差异；这与不允许普通 trailing comma 的严格 JSON 文件不同。

### `getOrCreateAssociatedTokenAccount`

该链下辅助函数接收 connection、payer、Mint 和 token owner：

1. 计算该 owner 对应该 Mint 的标准 ATA 地址。
2. 查询 ATA 是否已经存在。
3. 存在则读取并返回。
4. 不存在则构造并发送创建 ATA 的交易，确认后读取并返回。

由于当前测试每次刚创建一个新 Mint，该用户对应的 ATA 正常情况下还不存在，因此实际会走创建路径。

### 参数

```typescript
getOrCreateAssociatedTokenAccount(
  provider.connection,
  payer,
  mint,
  user
)
```

- `provider.connection`：查询账户和发送交易所用 RPC connection。
- `payer`：支付 ATA rent 和交易费的 Keypair signer。
- `mint`：刚创建的 Mint `PublicKey`。
- `user`：新 ATA 的 token authority/owner `PublicKey`。

这里的 payer 和 token owner 可以是不同身份。本测试中它们来自同一个测试钱包，但参数角色仍然不同。

### 返回对象

```typescript
const userTokenAccount = await getOrCreateAssociatedTokenAccount(...);
```

返回值不是单独的 PublicKey，而是解析后的 Token Account 信息对象。它包含例如：

- `address`：Token Account 地址。
- `mint`：关联 Mint 地址。
- `owner`：token authority 地址。
- `amount`：最小单位余额。

因此取得地址时写：

```typescript
userTokenAccount.address
```

再调用：

```typescript
userTokenAccount.address.toBase58()
```

把该 PublicKey 转成用于显示的字符串。

---

## 二十一、TypeScript 铸造测试 Token

### 数学运算符 `**`

```typescript
const TOKENS_TO_MINT = 100 * 10 ** TOKEN_DECIMALS;
```

`**` 是乘方运算符。`TOKEN_DECIMALS = 6` 时：

```text
10 ** 6 = 1,000,000
100 * 1,000,000 = 100,000,000 最小单位
```

这里使用 JavaScript `number`。当前测试金额远低于 JavaScript 的安全整数上限，因此精确；处理任意真实 `u64` Token amount 时应使用 bigint 或专门的大整数表示，不能默认所有 `u64` 都能由 number 精确表达。

### `mintTo`

```typescript
const mintToSignature = await mintTo(
  connection,
  payer,
  mint,
  destination,
  authority,
  amount
);
```

这是 SPL Token JavaScript 客户端包装函数。它构造 Token Program 的 MintTo instruction、创建交易、收集签名、发送并等待确认。

本项目参数角色：

- `provider.connection`：RPC connection。
- 第二个 `payer`：支付交易费。
- `mint`：要增发哪种 Token。
- `userTokenAccount.address`：新 Token 进入哪个 Token Account。
- 第五个 `payer`：以 mint authority 身份签名。
- `TOKENS_TO_MINT`：铸造的最小单位数量。

同一个 Keypair 在本测试中承担两个角色：fee payer 和 mint authority，所以变量 `payer` 出现两次。API 按角色分别接收参数，角色相同不代表参数可以省略。

### 公钥与 signer 的区别

创建 Mint 时存入 Mint Account 的 mint authority 是 `user` PublicKey；执行 MintTo 时，仅提供这个公开地址不构成授权，还必须由对应 Keypair 签名。

本测试满足：

```text
user == payer.publicKey
```

因此将 `payer` Keypair 作为 authority 参数，库可以为交易签名。

### 返回的 transaction signature

```typescript
const mintToSignature = await mintTo(...);
```

成功返回交易签名字符串，可用于日志、区块浏览器或 RPC 查询。它不是钱包私钥，也不是 Token amount。

---

## 二十二、TypeScript 派生 PDA

### 静态方法调用

```typescript
anchor.web3.PublicKey.findProgramAddressSync(...)
```

- `anchor.web3`：Anchor 暴露的 web3.js 模块。
- `.PublicKey`：PublicKey 类。
- `.findProgramAddressSync`：定义在 PublicKey 类本身上的静态方法，不需要先创建某个 PublicKey 实例。

`Sync` 表示同步版本：计算完全在本地完成，函数直接返回结果，不返回 Promise，所以不使用 `await`。

### `Buffer.from("vault")`

PDA seeds 必须是 bytes。`Buffer.from` 把字符串按默认 UTF-8 编码转换成 Node.js Buffer：

```text
"vault" → [118, 97, 117, 108, 116]
```

它必须与 Rust 常量 `b"vault"` 的字节完全一致。字符串内容和大小写都会影响 PDA 地址。

### `PublicKey.toBuffer()`

```typescript
user.toBuffer()
mint.toBuffer()
vaultState.toBuffer()
```

把 PublicKey 转换成其 32-byte Buffer 表示，供 PDA 派生作为 seed。它不是 Base58 字符串的 bytes，也不包含私钥。

### 两个参数

```typescript
PublicKey.findProgramAddressSync(seeds, programId)
```

1. `seeds`：有顺序的 byte buffers 数组。
2. `programId`：PDA 属于哪个程序的派生域。

`program.programId` 来自 Anchor program client/IDL，表示 Token Vault Program 地址。

### 数组字面量

```typescript
[Buffer.from("vault"), user.toBuffer(), mint.toBuffer()]
```

方括号创建 JavaScript 数组。元素顺序是 PDA 规则的一部分，不能调换。

### 数组解构

`findProgramAddressSync` 返回一个二元素数组/tuple：

```text
[PDA PublicKey, canonical bump]
```

写法：

```typescript
const [vaultState, vaultStateBump] = result;
```

按位置把第一个返回值赋给 `vaultState`，第二个赋给 `vaultStateBump`。

这不等同于声明一个普通数组变量；左侧方括号是解构赋值语法。

### 客户端与链上验证的关系

客户端派生只用于提前得到应传给 instruction 的账户地址：

```text
客户端用 seeds + programId 计算地址
        ↓
把地址放进 instruction accounts
        ↓
Anchor 链上用相同 seeds + programId + bump 重算
        ↓
相等才接受
```

客户端计算结果不被链上盲目信任。

### 本项目两组 seeds

VaultState：

```typescript
[Buffer.from("vault"), user.toBuffer(), mint.toBuffer()]
```

必须对应 Rust：

```rust
[VAULT_STATE_SEED, user.key().as_ref(), mint.key().as_ref()]
```

Vault Token Account：

```typescript
[Buffer.from("vault_token"), vaultState.toBuffer()]
```

必须对应 Rust：

```rust
[VAULT_TOKEN_ACCOUNT_SEED, vault_state.key().as_ref()]
```

---

## 二十三、TypeScript 调用 `initializeVault`

### 导入 `TOKEN_PROGRAM_ID`

```typescript
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
```

这是经典 SPL Token Program 的标准 PublicKey 常量。使用库提供的常量，避免手写 Base58 地址时拼错。

### Builder 链

```typescript
program.methods
  .initializeVault()
  .accountsPartial({...})
  .rpc();
```

每一步返回一个带有下一步方法的新 builder 对象，因此可以连续用点号调用。换行不终止表达式；最后的分号才结束整条语句。

线性含义：

1. 从 program client 进入 methods builder。
2. 选择 `initializeVault` instruction 并编码参数（本 instruction 没有业务参数）。
3. 指定 instruction accounts。
4. 构造、签名、发送交易并等待确认。

### instruction 名称转换

Rust 入口：

```rust
initialize_vault
```

IDL/TypeScript methods 使用小驼峰：

```typescript
initializeVault()
```

TypeScript 大小写敏感，必须使用生成类型提供的准确名称。

### `.accountsPartial({...})`

接收一个 JavaScript object，把 object 属性映射到 instruction 的账户名称。

`Partial` 表示该 API 允许 Anchor 的账户解析器补全它能推导或识别的账户；本项目为了学习清晰，仍显式写出六个账户，而不依赖隐式补全。

对象使用小驼峰属性名：

```text
vault_state        → vaultState
vault_token_account → vaultTokenAccount
token_program      → tokenProgram
system_program     → systemProgram
```

### 对象属性简写

```typescript
{
  user,
  mint,
  vaultState,
}
```

当属性名和变量名相同，JavaScript 允许省略冒号右侧：

```typescript
{ user }
```

等价于：

```typescript
{ user: user }
```

而：

```typescript
tokenProgram: TOKEN_PROGRAM_ID
```

属性名与变量/表达式名不同，所以必须写 `属性名: 值`。

### System Program ID

```typescript
anchor.web3.SystemProgram.programId
```

`SystemProgram` 是 web3.js 提供的 System Program 辅助 class/对象，`.programId` 是标准 System Program PublicKey。

### `.rpc()`

`.rpc()` 完成：

1. 构造 instruction 和 transaction。
2. 使用 provider wallet 支付交易费并为 `user` 签名。
3. 发送到 provider connection 对应的 RPC。
4. 等待交易确认。
5. 成功返回 transaction signature 字符串；失败则抛出错误。

由于 `user` 就是 provider wallet 的 public key，不需要额外 `.signers(...)`。如果 instruction 需要 provider 之外的新 Keypair signer，才要显式提供。

### 尚未存在也可以传入的账户地址

调用之前：

- `user` 已存在。
- `mint` 已由测试创建。
- `tokenProgram` 和 `systemProgram` 已存在。
- `vaultState` 与 `vaultTokenAccount` 只是已计算地址，账户尚未创建。

`initializeVault` 的 `init` 约束会在链上重新验证 PDA 地址后创建后两个账户。

---

## 二十四、读取并断言 Anchor Account

### Chai 与 `expect`

```typescript
import { expect } from "chai";
```

Chai 是测试断言库；`expect` 用于声明“实际值应该满足什么条件”。条件不满足时会抛出 assertion error，Mocha 将当前 `it` 判定为失败。

### Anchor account client

```typescript
program.account.vaultState
```

`program.account` 提供由 IDL 生成的 Anchor account clients；`vaultState` 对应 Rust 中的 `VaultState` account 类型。

这里的小驼峰名称由生成类型提供：

```text
VaultState → vaultState
```

### `.fetch(address)`

```typescript
const storedVaultState = await program.account.vaultState.fetch(vaultState);
```

执行流程：

1. 通过 provider connection 查询 `vaultState` 地址的链上账户。
2. 验证/解析 Anchor discriminator。
3. 按 IDL 中的 `VaultState` 布局反序列化账户 data。
4. 返回 TypeScript 对象。

它是 RPC 查询，所以返回 Promise，需要 `await`。它只读取链上状态，不发送交易、不签名、不消耗 SOL。

### PublicKey `.equals`

```typescript
storedVaultState.owner.equals(user)
```

JavaScript 对象直接使用 `==`/`===` 主要比较是否为同一个对象引用，而不是自动比较两个 PublicKey 的 32-byte 内容。`.equals(other)` 比较公钥值，返回 boolean。

### Chai 链式断言

```typescript
expect(actual).to.equal(expected);
```

- `expect(actual)`：包装实际值。
- `.to`：提高可读性的链式属性。
- `.equal(expected)`：要求实际值严格等于预期值。

本项目：

```typescript
expect(storedVaultState.owner.equals(user)).to.equal(true);
expect(storedVaultState.mint.equals(mint)).to.equal(true);
expect(storedVaultState.bump).to.equal(vaultStateBump);
```

前两条先用 PublicKey `.equals` 得到 boolean；第三条直接比较两个 number bump。

---

## 二十五、TypeScript 调用 Deposit

### Deposit amount 常量

```typescript
const TOKENS_TO_DEPOSIT = 30 * 10 ** TOKEN_DECIMALS;
```

当 decimals 为 6 时，得到 30,000,000 最小单位，即界面意义上的 30 Token。

### `new`

```typescript
new anchor.BN(TOKENS_TO_DEPOSIT)
```

`new` 调用 class 的 constructor 并创建一个新对象。这里创建 Anchor 使用的 BN 大整数对象。

大致形状：

```text
anchor.BN          BN class
new anchor.BN(...) 创建 BN 实例
```

### 为什么 Rust `u64` 使用 BN

Rust instruction 参数 `amount` 是 `u64`，范围可超过 JavaScript `number` 能精确表示的安全整数范围。Anchor TypeScript client 使用 BN 表示这类 64-bit 整数，避免在编码 instruction data 前已经损失精度。

当前 30,000,000 本身可以由 number 精确表示，但转换为 BN 是为了满足 Anchor 的 `u64` 客户端表示和保持统一安全习惯。

### `.deposit(...)`

```typescript
program.methods.deposit(new anchor.BN(TOKENS_TO_DEPOSIT))
```

选择 IDL 中的 deposit instruction，并把 BN 编码成 Rust handler 接收的 `u64 amount` instruction data。

### Deposit Accounts

```typescript
.accountsPartial({
  user,
  mint,
  vaultState,
  userTokenAccount: userTokenAccount.address,
  vaultTokenAccount,
  tokenProgram: TOKEN_PROGRAM_ID,
})
```

- `user`：provider wallet PublicKey，同时是交易 signer 和源 Token Account authority。
- `mint`：测试 Mint。
- `vaultState`：当前 user + mint 对应的状态 PDA。
- `userTokenAccount`：传入返回对象的 `.address`，即源 ATA PublicKey。
- `vaultTokenAccount`：目标 Vault Token Account PDA。
- `tokenProgram`：经典 SPL Token Program ID。

Deposit 不创建账户，因此不需要 System Program。

### 客户端与链上 authority

客户端 `.rpc()` 使用 provider wallet 签署外层交易。链上 Deposit handler 再把同一个 `user` 作为 TransferChecked CPI authority。由于 signer privilege 可以向 CPI 传递，Token Program 能确认源 Token Account authority 已签名。

---

## 二十六、读取并断言 SPL Token Account 余额

### `getAccount`

```typescript
getAccount(connection, tokenAccountAddress)
```

这是 `@solana/spl-token` 的链下读取函数。它通过 RPC 查询指定地址、验证/解析经典 SPL Token Account data，并返回当前账户信息对象。

它与 Anchor 的：

```typescript
program.account.vaultState.fetch(...)
```

用途相似但解析目标不同：前者解析 SPL Token Account，后者按 Anchor IDL 解析我们程序的 VaultState。

### 返回对象是状态快照

`getOrCreateAssociatedTokenAccount` 之前返回的 `userTokenAccount` 对象，是当时读取到的账户状态快照。后续 MintTo 和 Deposit 修改链上余额时，该 JavaScript 对象不会自动更新。

因此 Deposit 后必须再次调用 `getAccount`，取得最新余额。

### `.amount`

SPL Token JavaScript 客户端将 Token Account 的 `u64 amount` 表示为 JavaScript `bigint`，避免普通 number 无法精确覆盖整个 u64 范围。

### `Number(...)`

```typescript
Number(userAccountAfterDeposit.amount)
```

调用 JavaScript 内置 `Number` 转换函数，把 bigint 转成 number。

本测试的最大金额为 100,000,000，远低于 `Number.MAX_SAFE_INTEGER`，因此转换精确。真实项目处理任意 u64 时，不应为了方便无条件转成 number；应直接使用 bigint 或大整数类型比较。

### 余额断言

```text
初始用户余额 = 100 Token
Deposit       = 30 Token
用户余额      = 70 Token
Vault 余额    = 30 Token
```

代码使用最小单位比较，不使用带小数的显示金额，避免浮点数问题。

---

## 二十七、TypeScript 调用 Withdraw

### Withdraw amount

```typescript
const TOKENS_TO_WITHDRAW = 10 * 10 ** TOKEN_DECIMALS;
```

当前等于 10,000,000 最小单位，即 10 Token。调用时转换为 BN，以编码 Rust `u64 amount`。

### Withdraw builder

```typescript
program.methods
  .withdraw(new anchor.BN(TOKENS_TO_WITHDRAW))
  .accountsPartial({...})
  .rpc();
```

客户端账户集合与 Deposit 高度相似，但链上 TransferChecked 的 `from`、`to` 和 `authority` 相反：

```text
Deposit： user ATA → Vault；authority = user
Withdraw：Vault → user ATA；authority = VaultState PDA
```

### 为什么 TypeScript 不提供 PDA signer

外层 transaction 仍由 provider wallet 签名，证明当前调用者是 `user`。PDA 没有 Keypair，客户端不能也不需要为它提供 `.signers(...)`。

进入链上 Withdraw handler 后：

1. Anchor 验证 `user` signer、VaultState seeds/owner/mint 和两个 Token Accounts。
2. handler 使用 VaultState 的 seeds + 保存的 bump。
3. `CpiContext::new_with_signer` 请求 runtime 为本次 Token Program CPI 授予 VaultState signer privilege。
4. Token Program 检查 Vault Token Account authority 等于已获得 signer privilege 的 VaultState。

因此有两个不同层次的授权：用户签署外层交易；PDA只在内层 CPI 中由 runtime 验证后成为 signer。

---

## 二十八、错误 Mint 测试：先准备有效账户，再故意传错关系

### 测试准备（setup）

测试准备是先创建要用的账户和状态，不是已经完成错误场景的验证。本项目此小步只创建第二个 Mint 和对应用户 ATA，尚未用它们调用 Withdraw。

```typescript
const otherMint = await createMint(
  provider.connection,
  payer,
  user,
  null,
  TOKEN_DECIMALS
);

const userOtherTokenAccount = await getOrCreateAssociatedTokenAccount(
  provider.connection,
  payer,
  otherMint,
  user
);
```

- `const otherMint = await ...`：等待 Mint 创建成功，再把返回的 `PublicKey` 保存为 `otherMint`。`const` 固定这个变量绑定，不表示链上账户的数据永远不变。
- 第一处 `user` 是新 Mint 的 mint authority；`null` 表示不设置 freeze authority；`TOKEN_DECIMALS` 复用 6 位精度。
- `createMint` 的可选 keypair 参数未传入，库会生成新 keypair，所以相同 authority、相同 decimals 不会让两次调用创建同一个 Mint。
- `const userOtherTokenAccount = await ...`：等待读取或创建新 Mint 对应的用户 ATA，保存返回的账户信息对象。其地址是 `userOtherTokenAccount.address`。
- 第二处 `user` 是 ATA 的 token authority，不是 runtime owner；runtime owner 仍是经典 SPL Token Program。
- `payer` 是支付创建账户费用和交易手续费的 Keypair；`user` 是公钥，两者在参数中的职责不同。

### 合法账户也可能是不符合本次指令要求的账户

| 账户 | Mint | token authority |
|---|---|---|
| 原 `userTokenAccount` | `mint` | `user` |
| 原 `vaultTokenAccount` | `mint` | `vaultState` PDA |
| 新 `userOtherTokenAccount` | `otherMint` | `user` |

新 ATA 本身不是损坏或伪造的账户。“错误”是相对于原 Vault 的 `token::mint = mint` 约束而言。

下一步调用 Withdraw 时，继续传入原 `mint` 和两个原 Vault PDA，仅将 `userTokenAccount` 换成新 ATA 的地址。如果连指令的 `mint` 参数也换成 `otherMint`，VaultState 的 seeds 检查就可能先失败，无法单独验证用户 Token Account 的 Mint 约束。

新 ATA 是未来的收款账户，不需要先 `mintTo`；没有预存 Token 不影响它作为收款账户接受检查。修改测试文件本身不会发送交易，账户准备发生在实际运行测试时。

参数参考：[createMint](https://solana-labs.github.io/solana-program-library/token/js/functions/createMint.html)、[getOrCreateAssociatedTokenAccount](https://solana-labs.github.io/solana-program-library/token/js/functions/getOrCreateAssociatedTokenAccount.html)。

---

## 二十九、错误 Mint 请求与失败后的余额证明

### 控制变量：只替换一个账户

```typescript
.accountsPartial({
  user,
  mint,
  vaultState,
  vaultTokenAccount,
  userTokenAccount: userOtherTokenAccount.address,
  tokenProgram: TOKEN_PROGRAM_ID,
})
```

对象中使用 `user`、`mint`、`vaultState`、`vaultTokenAccount` 这种简写时，属性名和变量名相同。`userTokenAccount` 这一项没有简写，因为属性名固定为指令要求的账户名称，但本次故意把它的值指定为另一个对象的 `.address`。

### 为什么仍由 Alice 签名

本场景不是再次测试 Bob 冒充 Alice。外层交易仍由 provider wallet，也就是 `user` 自动签名。新 ATA 的 token authority 也确实是 `user`。这样 signer 和 authority 都正确，唯一错误关系就是 Token Account 的 Mint。

### `ConstraintTokenMint`

Withdraw 的账户约束是：

```rust
#[account(
    mut,
    token::mint = mint,
    token::authority = user,
    token::token_program = token_program
)]
pub user_token_account: Account<'info, TokenAccount>,
```

Anchor 按账户结构和约束生成验证代码。实际 Token Account 的 `mint` 字段不等于传入的 `mint.key()` 时，预期返回 `ConstraintTokenMint`。由于失败发生在 Accounts 验证阶段，`handle_withdraw` 不会执行，PDA signer seeds 也不会被使用。

### 错误类型断言和错误码断言不是重复

```typescript
expect(wrongMintWithdrawError).to.be.instanceOf(anchor.AnchorError);

const wrongMintAnchorError =
  wrongMintWithdrawError as anchor.AnchorError;

expect(wrongMintAnchorError.error.errorCode.code).to.equal(
  "ConstraintTokenMint"
);
```

第一项在运行时证明捕获到的是 AnchorError，而不是 RPC 断线等任意异常。第二项进一步证明失败原因正是 Mint 约束。`as anchor.AnchorError` 只帮助 TypeScript 后续访问属性，不会在运行时检查或改变这个对象。

### 失败交易之后为什么重新读取

失败后重新调用三次 `getAccount`，是从链上取得新的状态快照。随后分别比较原用户、Vault 和错误接收账户的 `amount`：

```text
错误请求前状态 ──比较──> 错误请求后状态
```

三个比较都相等，才说明这个失败请求没有把 Token 转走，也没有错误地把另一种 Token 的账户改掉。这里检查的是 Token 余额，不包括交易付款人的 SOL 手续费。
