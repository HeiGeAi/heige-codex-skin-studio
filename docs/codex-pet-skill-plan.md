# ChatGPT Desktop Codex Pet Skill 方案

> 状态：MVP 实施中；Codex V2 Desktop 契约已冻结，macOS 可见 Settings > Pets Refresh、选择和自定义精灵资源加载已完成真实验证；当前 Desktop 不识别 `/pet` 命令；Windows 当前 Codex Renderer 的主题注入已通过 E2E，但干净 Runner 未暴露可见 Settings/Preferences 控件，Pet 原生选择仍待真实登录桌面验收
> 研究日期：2026-07-17
> 目标平台：ChatGPT Desktop macOS 和 Windows
> 关联项目：`codex-skin-studio`
> 产品边界：Pet 是独立的浮动 Overlay，不是主窗口 CSS 皮肤，也不是 `app.asar` 修改方案。

> 重要说明：本文同时记录已确认的产品决策、随 ChatGPT Desktop 提供的 Codex V2 `hatch-pet` 契约和官方 Web 公开规格。Desktop 新 Pet 必须使用 `spriteVersionNumber: 2` 的 `1536 × 2288`、8 × 11 图集；`1536 × 1872` 的 8 × 9 图集只能作为中间组装产物。Web 上传规格仍是另一条透明 PNG/WebP、`1536 × 1872`、不超过 `20 MiB` 的路径。

## 0. 实施标准和完成定义

### 0.1 MVP 范围

本 MVP 只交付一个可重复执行的 Pet 生成和安装流程：

```text
参考图或文字需求
  -> Codex Agent 分析主体和风格
  -> Codex 原生 Image Generation 生成角色基准图和动作素材
  -> 本地脚本生成 8 × 9 标准行中间图集
  -> 本地脚本补齐 16 个视角并生成 8 × 11 v2 图集
  -> 本地脚本验证图集和 manifest
  -> 原子安装到用户 Pet 目录
  -> 用户在 ChatGPT Desktop Pets 设置中 Refresh 并选择
```

MVP 必须完成：

- 一个英文 `SKILL.md` Pet 工作流；
- 一个可复现的图集组装命令；
- 一个只读验证命令；
- 一个带回滚的安装命令；
- 一个可安装的真实示例 Pet；
- macOS 和 Windows 的路径、错误和安装测试；
- 一次真实 ChatGPT Desktop Refresh、选择和 Pet Overlay 显示验证；当前 macOS 已完成，当前版本发送 `/pet` 的结果必须记录为“不识别命令”，不能伪造为唤醒成功。

MVP 不包含：

- 根据项目、时间、模型或工作区隐式切换不同 Pet 包；
- 修改 ChatGPT Desktop 应用包或签名；
- 外部图片服务或独立网站；
- 自动控制 Pet Overlay 的 CDP 注入；
- 未经官方契约确认的自定义动画事件编排。

### 0.2 三层职责

| 层 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| Codex Agent / Skill | 需求解析、图片角色分类、Prompt、调用原生 Image Generation、Vision 复核 | 直接写入 Pet 目录、假设生成成功 |
| 本地 Node.js 工具 | 去背景、缩放、基线、图集、manifest、验证、原子安装 | 调用 Image Generation、替代 Vision 判断 |
| ChatGPT Desktop | Pet Overlay、任务状态、动画播放、Refresh 和选择 | 接受未经验证的图集、提供稳定的第三方动画 API |

### 0.3 Definition of Done

只有同时满足以下条件，才允许报告“Pet Skill MVP 完成”：

1. P0 契约记录已提交，包含实际版本、真实 `pet.json`、图集尺寸、列数、行数、行语义和 Refresh 结果。
2. `create-pet.mjs`、`validate-pet.mjs`、`install-pet.mjs` 已实现，并且不依赖用户手工移动文件。
3. 失败的验证或安装不会改变已有 Pet。
4. 一个真实 Pet 在 macOS ChatGPT Desktop 上可 Refresh、选择并显示 Overlay 与动画状态。
5. Windows 路径和安装流程通过自动化测试；主题注入已在当前 Windows Codex Renderer E2E 通过；Pet 原生选择仍需在有可见 Settings > Appearance > Pet 的真实登录桌面完成一次手工验证。
6. 生成失败、契约不匹配、透明度失败和应用 Refresh 失败均有明确错误信息。
7. 所有分发的 `SKILL.md`、脚本、模板、示例 manifest 和日志均为英文 ASCII。

未满足上述条件时，状态只能写为 `design`、`contract-pending` 或 `implementation-in-progress`，不能写为 `ready` 或 `installed`。

## 1. 结论

Pet 能力应作为 `codex-skin-studio` 的独立扩展，不直接并入主界面换肤 Runtime。

推荐架构：

```text
Codex Pet Skill
  -> 理解人物或物体参考图
  -> 调用 Codex 原生 Image Generation
  -> 生成卡通化动作素材
  -> 本地确定性裁切、对齐和拼图
  -> 生成并校验 pet.json
  -> 安装到 ~/.codex/pets/<pet-id>/
  -> ChatGPT Desktop Settings > Pets > Refresh
```

核心原则：

1. Codex Image Generation 负责角色设计、动作设计和视觉一致性。
2. Node.js 脚本负责尺寸、透明通道、图集布局、文件路径和校验。
3. ChatGPT Desktop 原生负责 Pet Overlay、任务状态和动画状态切换。
4. 不修改 `app.asar`、应用签名、官方 JavaScript 或内置 Pet 资源。
5. 不通过主窗口 CDP CSS 注入控制 Pet Overlay；Pet Overlay 是独立的窗口和渲染路径。

## 2. 不可降级的视觉标准

每一个 Pet 必须满足以下条件，否则不能进入安装阶段。

### 2.1 造型方向

Pet 必须是：

- 卡通化，而不是写实人物或照片；
- 拟人化，能够通过表情、姿态和动作表达工作状态；
- 大头小身体，头部是第一视觉焦点；
- 轮廓清晰，缩小后仍能识别；
- 适合桌面陪伴，不使用惊悚、血腥、攻击性或过度复杂的视觉语言。

### 2.2 比例标准

默认角色比例：

```text
头部高度：占角色总高度约 45%-60%
身体高度：占角色总高度约 40%-55%
头宽：不小于肩宽的 1.1 倍
脚部和手部：允许简化，但必须保持可识别姿态
角色占单帧高度：约 72%-90%
四周安全边距：至少 6%，不得裁切头发、耳朵、道具或脚部
```

这些数值是生成和 QA 的默认范围，不是要求每个角色具有相同的精确比例。特殊物体型 Pet 可以改变身体结构，但仍必须保留明显的“大头、小身体、拟人动作”视觉意图。

### 2.3 角色一致性

所有动作帧必须保持：

- 发型、脸型、眼睛和主要表情特征；
- 服装主色、材质、徽记和标志性配件；
- 头身比例和身体轮廓；
- 角色朝向逻辑；
- 透明背景和统一光照方向。

不得出现：

- 写实照片风格；
- 每帧不同脸型或不同服装；
- 多余角色；
- 文字、Logo、水印、对话框或 UI；
- 被裁切的头部和脚部；
- 复杂背景、地面、投影或不可去除的阴影。

## 3. 是否可以调用 Codex 生图

可以，但调用边界必须明确。

### 3.1 调用方式

Pet Skill 由 Codex Agent 调用原生 Image Generation。Node.js 脚本不直接调用 Image Generation API，也不要求用户配置额外的 `OPENAI_API_KEY`。

Image Generation 不可用时，Skill 必须报告原始错误并停止，不得假装生成完成，也不得自动切换到外部图像服务。

### 3.2 不建议单次生成最终图集

不建议让模型一次生成完整的 `8 × 11` 精灵图。常见风险：

- 网格线和单元格尺寸漂移；
- 每帧人物比例不一致；
- 脸部、服装和配件逐帧变化；
- 动作超出单元格；
- 背景无法真正透明；
- 出现文字、装饰线或额外角色。

推荐分两步：

```text
Image Generation 生成角色基准图
        ↓
Image Generation 生成动作帧或动作参考
        ↓
本地脚本统一尺寸和透明边缘
        ↓
本地脚本拼接 8 × 9 标准行中间图集
        ↓
本地脚本补齐两行共 16 个顺时针视角
        ↓
本地脚本生成 8 × 11 v2 图集
```

### 3.3 推荐生图批次

第一批生成一张角色基准图，锁定：

- 大头小身体比例；
- 发型、脸部、服装和配件；
- 卡通化和拟人化程度；
- 主色和轮廓；
- 透明化所需的纯色背景。

第二批按动作状态生成素材。默认状态集合为：

```text
idle
running-right
running-left
waving
jumping
failed
waiting
running
review
```

实际行顺序和动画语义必须以当前 `hatch-pet` Skill 生成的契约为准。不要仅凭旧社区示例自行假定永久稳定的行映射。

## 4. 图集生成流程

### 4.1 输入分类

每张输入图必须明确角色：

- `subject/object`：保留人物或物体身份；
- `style-reference`：只继承色彩、材质和画风；
- `brand/logo`：只有用户明确授权时才使用。

如果用户提供的是人物主体，必须优先保持身份和标志性特征，再进行卡通化和拟人化。不要把风格参考图中的人物错误地当作主体复制。

### 4.2 动作提示词模板

```text
Create a cute anthropomorphic cartoon desktop pet based on the approved character reference.

Visual requirements:
- large head and small body;
- friendly expressive face;
- simplified readable silhouette;
- consistent hairstyle, outfit colors, accessories, and proportions;
- compact mascot scale suitable for a desktop overlay;
- no photorealism, no text, no logo, no watermark, no extra characters.

Action: <one action only>
Pose: <specific pose>
Expression: <specific expression>
Motion direction: <left, right, or front>
Background: perfectly flat #00FF00 chroma-key color;
no shadows, gradients, floor, texture, reflection, or background objects.
Keep the entire character inside the canvas with generous transparent-safe padding.
```

每次只生成一个动作或一个受控动作变体。不要在同一提示中混合多个动作状态。

### 4.3 透明化

默认使用纯色 chroma-key 背景：

```text
Codex Image Generation
  -> flat #00FF00 background
  -> local chroma-key removal
  -> alpha validation
  -> WebP output
```

本地去背景后必须检查：

- 四角 alpha 为 0；
- 角色主体 alpha 覆盖率合理；
- 头发、耳朵、手指和道具边缘没有明显绿边；
- 角色内部没有误删透明洞；
- 没有残留地面阴影。

复杂毛发、半透明材质、烟雾或玻璃等内容如无法通过 chroma-key 保留边缘，必须单独说明需要原生透明图像路径，不得默默降低质量。

### 4.4 本地确定性处理

建议使用 Node.js 和 `sharp` 完成：

1. 读取每张动作素材。
2. 去除或验证透明背景。
3. 按同一比例缩放角色。
4. 将角色居中放置到统一帧画布。
5. 对左右移动帧保持一致的脚底基线。
6. 对不含方向性配件的动作允许镜像生成反向帧。
7. 将九个标准动作行填入 8 × 9 中间图集，未使用单元格保持完全透明。
8. 生成并校验两个包含 16 个顺时针视角的 look rows。
9. 将 neutral/front fallback 放入 row 0 column 6，生成 8 × 11 v2 图集。
10. 导出 RGBA WebP。
11. 输出 contact sheet 供 Vision 检查。

Desktop v2 使用 8 列 × 11 行，每帧 `192 × 208`，最终输出为 `1536 × 2288`。row 0-8 是标准动作；row 9 是 `000` 到 `157.5` 度；row 10 是 `180` 到 `337.5` 度。`000` 表示向上，不是正面；正面使用 idle fallback。官方 Web `1536 × 1872` 规格只能用于 Web 上传或中间产物校验，不能作为新 Desktop Pet 的最终尺寸。

## 5. Pet 文件契约

```text
~/.codex/pets/<pet-id>/
├── pet.json
└── spritesheet.webp
```

当前 Desktop v2 manifest 已由随应用提供的 `hatch-pet` 契约确认：

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "A cute anthropomorphic desktop companion.",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp"
}
```

MVP 不应自行添加未经当前应用验证的 `animation`、`chains` 或事件字段。社区已有提案希望让这些字段可配置，但当前应用仍主要负责动画行和事件映射。[OpenAI Codex Issue #20863](https://github.com/openai/codex/issues/20863)

### 5.1 P0 官方契约冻结

官方 v2 契约和本机观测记录保存在：

```text
docs/pet-contract/official-baseline-2026-07-17/
├── README.md
└── contract.json
```

该记录的 `recordStatus` 是 `observed-reference`。本机从
`/Applications/ChatGPT.app/Contents/Resources/skills/skills/.curated/hatch-pet/`
读取了 `codex-pet-contract.md` 和 `SKILL.md`，确认了 `spriteVersionNumber: 2`、
`1536 × 2288`、8 × 11、16 个视角和 manifest 必填字段。官方文档另外确认
了 Web 上传规格以及 Desktop 的 `Settings > Pets > Refresh`、选择和 Overlay 流程；当前版本的 `/pet` 命令实测不可用；
仍没有公开桌面端程序化选择 API。

在编写安装器之前，必须通过当前 ChatGPT Desktop 和官方 `hatch-pet` Skill 取得一份真实样例。P0 产物保存为内部开发记录，不上传用户参考图或生成中间图：

```text
docs/pet-contract/<observed-version>/
├── contract.json
├── pet.json.example
└── README.md
```

`contract.json` 至少记录：

- ChatGPT Desktop 版本和平台；
- `hatch-pet` Skill 版本或生成日期；
- manifest 实际必需字段和允许字段；
- spritesheet 文件格式、色彩模式和 alpha 行为；
- 列数、行数、单帧宽高和总图尺寸；
- 每一行的实际动画语义、方向和帧数；
- Refresh 后显示名称、缩略图、selected-row 和 Pet Overlay 状态；如果版本支持 `/pet`，额外记录其结果；
- 失败时的原始错误和恢复步骤。

安装器只能读取已冻结契约中的字段。若当前应用输出的格式不是 8 列 × 9 行，工具必须报告 `PET_CONTRACT_MISMATCH`，不能通过“仍然可被 8 和 9 整除”来假装兼容。

### 5.2 跨平台目录和路径

逻辑 Pet 根目录统一命名为 `CODEX_PETS_DIR`，默认值为：

```text
macOS:  $CODEX_HOME/pets 或 $HOME/.codex/pets
Windows: %CODEX_HOME%\\pets 或 %USERPROFILE%\\.codex\\pets
```

实现要求：

- 使用 Node.js `path` 和 `os.homedir()`，禁止拼接 `/` 或硬编码用户名；
- 允许 `--pets-dir` 覆盖默认目录，便于测试和用户迁移；
- 使用 `path.resolve` 后确认目标目录位于 Pet 根目录内；
- 不跟随指向 Pet 根目录外部的符号链接；
- Windows 安装必须支持空格路径和 Unicode 用户名；
- 输出 JSON 时使用绝对路径，日志中的路径按当前平台格式输出。

### 5.3 MVP 命令接口

脚本必须支持稳定的 JSON 输出，供 Skill 和测试读取。命令失败时使用非零退出码，并在 JSON 中返回稳定 `code`：

```bash
node scripts/create-pet.mjs \
  --id "pet-id" \
  --name "Pet Name" \
  --frames "/absolute/path/to/frames" \
  --out "/absolute/path/to/pet-id" \
  --contract "/absolute/path/to/contract.json" \
  --json

node scripts/validate-pet.mjs \
  "/absolute/path/to/pet-id" \
  --contract "/absolute/path/to/contract.json" \
  --json

node scripts/install-pet.mjs \
  "/absolute/path/to/pet-id" \
  --pets-dir "/absolute/path/to/pets" \
  --contract "/absolute/path/to/contract.json" \
  --json
```

命令契约：

- `create` 只生成临时输出，不写入用户 Pet 根目录；
- `validate` 只读，不修改输入目录；
- `install` 必须先完整执行 `validate`，再原子替换目标目录；
- `--dry-run` 只允许在 `validate` 和 `install` 上使用；
- 缺少输入、契约不匹配、图片解码失败、alpha 失败和路径越界必须返回稳定错误码；
- 默认不覆盖同 ID Pet，只有显式 `--replace` 才允许替换。

建议错误码：

```text
PET_INPUT_INVALID
PET_CONTRACT_MISMATCH
PET_IMAGE_INVALID
PET_ALPHA_INVALID
PET_SPRITESHEET_INVALID
PET_MANIFEST_INVALID
PET_PATH_UNSAFE
PET_INSTALL_FAILED
```

## 6. 建议的 Skill 文件结构

```text
skill/codex-skin-studio/
├── SKILL.md
├── scripts/
│   ├── pet.mjs
│   ├── create-pet.mjs
│   ├── validate-pet.mjs
│   └── install-pet.mjs
│   ├── paired.mjs
│   ├── create-paired.mjs
│   ├── switch-paired.mjs
│   └── paired-status.mjs
├── templates/
│   ├── pet-contract.json
│   └── pet.json
└── examples/
    └── pets/
        └── mascot/
            └── pet.json
```

### 6.1 处理依赖和输入布局

图像处理统一使用 `sharp`，作为 Pet 扩展的显式运行时依赖。不得依赖 macOS `sips`、Windows 画图工具或用户本机的其他图像软件，否则无法保证跨平台结果一致。

动作输入必须使用机器可读的布局 manifest，而不是依赖文件名猜测：

```json
{
  "contractVersion": "observed-version",
  "canvas": { "width": 192, "height": 208 },
  "rows": {
    "idle": { "row": 0, "frames": ["idle-00.png", "idle-01.png"] },
    "running": { "row": 1, "frames": ["running-00.png", "running-01.png"] }
  }
}
```

此输入 manifest 由 `create-pet.mjs` 消费，不等同于 ChatGPT Desktop 的 `pet.json`。真实行号、帧数和画布尺寸必须来自 P0 契约；示例数值仅用于说明格式，不能直接复制到生产 Pet。

使用 `sharp` 时必须：

- 固定解码、缩放、合成和 WebP 编码选项；
- 统一输出 RGBA，禁止丢失 alpha；
- 记录源图片哈希和最终图集哈希，便于复现；
- 限制单帧像素、总文件大小和输入数量，避免异常大图耗尽内存；
- 生成后重新解码最终 WebP，再执行验证，不能只验证编码前 buffer。

### `create-pet.mjs`

负责将已确认的动作素材组装成完整 Pet：

- 读取最终动作图片；
- 统一尺寸、缩放和基线；
- 生成 `spritesheet.webp`；
- 写入 `pet.json`；
- 输出 contact sheet；
- 不调用外部网络服务。

它必须在临时目录完成全部写入，只有验证通过后才移动到 `--out`。任何一步失败都删除临时目录，不留下半成品。

### `validate-pet.mjs`

负责阻止不合格 Pet 进入安装目录：

- `id`、名称和路径合法；
- manifest 引用的精灵图存在且在 Pet 目录内；
- 图片为 WebP 或 PNG；
- 图像有 RGBA alpha 通道；
- 图集尺寸可被 8 和 9 整除；
- 每个动作行至少包含有效帧；
- 角色没有被明显裁切；
- 四角透明；
- 帧间头身比例和脚底基线稳定。

验证分为两层：

1. **机器验证**：文件、路径、尺寸、alpha、边界、契约版本、哈希和大小限制。
2. **Vision 验证**：卡通化、拟人化、大头小身体、角色一致性、表情可读性和绿边。机器验证通过不代表视觉验收通过。

### `install-pet.mjs`

负责：

- 将经过校验的 Pet 原子复制到 `~/.codex/pets/<pet-id>/`；
- 不覆盖其他 Pet；
- 失败时回滚旧版本；
- 输出安装目录和 manifest；
- 提示用户在 ChatGPT Desktop 的 Pets 设置中 Refresh。

安装事务必须遵循：

```text
validate source
  -> copy source to sibling temporary directory
  -> rename existing target to backup
  -> rename temporary directory to target
  -> fsync/close handles where supported
  -> remove backup only after success
```

任何 rename、权限或磁盘空间错误都必须恢复旧目录，并返回 `PET_INSTALL_FAILED`。安装器不得删除用户 Pet 根目录中的其他 ID。

### 配套 Bundle 工具

已实现的配套工具职责：

- `create-paired.mjs`：校验主题和 Pet，生成 `bundle.json`、`theme/` 和 `pet/` 的原子 Bundle；
- `switch-paired.mjs`：校验 Bundle，安装匹配 Pet，调用现有主题 apply 流程，并记录配套状态；
- `paired-status.mjs`：合并报告主题 Renderer 状态、Pet 本地安装状态和 Bundle 状态；
- `pet.mjs` / `paired.mjs`：提供共享校验、图集、路径和事务安装实现。

当前 `switch-paired.mjs` 默认先尝试版本化的可见 UI 适配器。成功状态为 `theme-applied-pet-selected` 或 `theme-scheduled-pet-selected`，并要求真实的已选行和自定义精灵资源已加载 postcondition；UI 不可用时降级为 `theme-applied-pet-refresh-required` 或 `theme-scheduled-pet-refresh-required`。该适配器只操作 ChatGPT Desktop Settings > Pets 中的可见控件，不写私有状态、不修改应用资源。`--manual-pet` 可显式跳过适配器。完整配套激活还需要看到匹配的 Pet Overlay 和动画状态；如果当前版本不识别 `/pet`，必须记录该事实而不是伪造唤醒成功。

## 7. 用户体验

目标流程：

```text
用户：用这张图片生成一个大头小身体的日漫 Pet

Codex：分析主体和风格
Codex：生成卡通化基准角色
Codex：生成 idle / running / waiting / review 等动作
Codex：拼接并校验 8 × 9 标准行中间图集
Codex：生成并校验 16 个视角，拼成 8 × 11 v2 图集
Codex：安装到本地 Pet 目录

Codex：尝试通过可见 Settings > Pets 控件 Refresh 并选择匹配 Pet
Codex：记录 `native-ui-confirmed` 或 `refresh-required` 降级状态
Codex：检查匹配的 Pet 预览/Overlay、已加载的精灵资源和动画状态
```

Skill 必须报告：

- Pet 名称和 ID；
- 生成模式和输入图角色；
- 图集尺寸和单帧尺寸；
- 校验结果；
- 安装路径；
- 是否需要 Refresh 或重启。

每个阶段必须产生可审计结果：

```text
analyze     -> input-roles.json
generate    -> reference image paths and action image paths
assemble    -> spritesheet.webp + contact-sheet.webp
validate    -> validation.json
install     -> install.json
```

中间结果默认保存到临时工作目录，不复制到 Pet 安装目录。生成、拼图或安装失败时，报告最后一个成功阶段、稳定错误码和用户可执行的恢复动作。

Skill 不得把“图片已生成”推断为“Pet 已安装”，也不得把“文件已复制”推断为“ChatGPT Desktop 已显示”。最终状态必须区分：

```text
generated -> assembled -> validated -> installed -> refreshed -> selected -> overlay-visible -> animating
```

## 8. 自动切换边界

### 8.1 MVP 支持

- 同一个 Pet 内部由 ChatGPT Desktop 根据任务状态自动切换动画；
- 只有 P0 已确认行映射后，才声明 Running、Waiting、Review、Failed 等状态对应关系；
- 用户手动在 Settings > Pets 中切换不同 Pet；配套 Bundle 可通过可见 UI 适配器自动 Refresh 并选择匹配 Pet。

Pet Skill 不实现任务状态监听，也不伪造 ChatGPT Desktop 的状态事件。它只提供符合官方契约的图集；状态切换是否成功必须通过真实应用行为验收。

### 8.2 MVP 不支持

- 根据项目、时间、模型或工作区隐式切换不同 Pet 包；
- 根据时间、模型或工作区隐式切换 Pet；
- 通过主窗口 CDP CSS 控制独立 Pet Overlay；
- 修改应用包以重写内置 Pet 选择逻辑。

配套 Bundle 的显式切换不属于隐式自动切换：它由用户或 Skill 命令触发，并在失败时保留手动 Refresh 路径。任何未来的后台隐式切换仍应作为独立实验性 Worker，使用可见 UI 自动化而不是改写应用内部数据；该方案依赖 UI 结构，更新后容易失效。

## 9. 质量和安全验收

### 视觉验收

- 大头小身体在 100% 和缩略尺寸下都明显；
- 角色具有清晰眼睛、表情和拟人姿态；
- 9 行动作风格一致；
- 角色不超出任何单元格；
- 不出现写实照片、文字、水印和多余人物；
- contact sheet 可人工快速检查所有动作；
- 最终 Pet 在浅色和深色桌面上都可辨认。

### 工程验收

- `pet.json` 与精灵图路径一致；
- 图集 alpha 和尺寸验证通过；
- 安装使用原子写入；
- 安装失败不破坏已有 Pet；
- 不修改 `app.asar` 或应用签名；
- 不上传用户参考图或生成中间图；
- 外部社区 Pet 必须检查许可证和安装脚本。

### 自动化测试矩阵

至少覆盖：

| 类别 | 必测场景 |
| --- | --- |
| 输入 | 缺失图片、空文件、非图片、超大图片、重复帧、非法 ID |
| 图片 | PNG/JPEG/WebP 解码、RGB 转 RGBA、四角透明、绿边和内部误删检测 |
| 图集 | 8×11 v2 契约、单帧尺寸、行映射、帧数、未使用单元格透明、越界和裁切 |
| manifest | 必填字段、相对路径、目录越界、未知字段、契约版本不匹配 |
| 安装 | 首次安装、同 ID 拒绝覆盖、`--replace`、权限失败、磁盘失败、回滚 |
| 平台 | macOS 路径、Windows 空格路径、Windows Unicode 路径、不同路径分隔符 |
| 安全 | 符号链接越界、`..` 路径、外部 URL、超大解压或输出文件 |
| 运行 | Refresh 后出现、选择后 Overlay 可见、任务状态动画至少一轮；当前 macOS Overlay 已验证，`/pet` 在当前版本不识别，Windows 手工运行待验证 |

## 10. 实施阶段

### P0：验证官方契约

1. 安装或调用当前 `hatch-pet` Skill。
2. 从应用资源读取 `references/codex-pet-contract.md` 和对应 `SKILL.md`。
3. 生成一个大头小身体测试 Pet，完成标准行和 16 个视角。
4. 保存官方生成的 `pet.json` 和 8 × 11 图集。
5. 记录实际行顺序、尺寸和应用行为；macOS 已完成资源契约冻结和 Overlay 验证，Windows 需执行相同版本的应用 Refresh 验证。
6. 生成 `contract.json`；将当前版本“不识别 `/pet`”和未完成的 Windows 原生验证保持为明确状态，不能伪造为 `running`。

### P1：加入 Skill Agent 流程

1. 在英文 `SKILL.md` 中加入 Pet 生成模式。
2. 强制提示词包含 cartoon、anthropomorphic、large head、small body。
3. 由 Codex 原生 Image Generation 生成基准图和动作素材。
4. 由本地脚本拼接、校验和安装。
5. 只在 `validation.json` 为通过状态后允许安装。
6. 将 `generated`、`validated`、`installed`、`overlay-visible` 和 `animating` 状态分开报告。

### P2：增强质量工具

1. 自动生成 contact sheet。
2. 自动测量角色占比、alpha 覆盖率和脚底基线。
3. 增加逐帧视觉 QA 报告。
4. 支持用户确认后重生成单个失败动作。
5. 为失败动作保留稳定帧 ID，避免重生成导致整张图集行号漂移。

### P3：可见 UI 适配和平台验收

1. macOS 使用稳定的 Settings panel slug、custom avatar id 和可见 selected-row postcondition；不得依赖私有状态、私有存储或坐标点击。
2. Windows 使用 PowerShell 打开 Settings，并在可访问性或键盘自动化不可用时返回 `refresh-required`，不伪造已选择。
3. ChatGPT Desktop UI 更新后，如果适配器无法确认 selected-row，立即降级并更新版本化适配器，而不是放宽验证条件。

## 11. 推荐结论

第一版 Pet 能力采用：

```text
Codex 原生 Image Generation
  + 大头小身体卡通拟人角色规范
  + 多动作单帧生成
  + Sharp 本地确定性图集处理
  + pet.json 校验
  + ~/.codex/pets 原子安装
  + ChatGPT Desktop 原生状态动画
```

这条路线能最大化利用 Codex 的 Vision 和生图能力，同时把最容易出错的尺寸、透明度、边界和文件安装交给确定性脚本。它不会依赖修改 ChatGPT Desktop，也不会把 Pet Overlay 和主界面皮肤耦合在一起。

## 12. 研究依据

- [OpenAI ChatGPT Pets documentation](https://learn.chatgpt.com/docs/pets?surface=app)
- [OpenAI ChatGPT Desktop Settings](https://learn.chatgpt.com/docs/reference/settings)
- [OpenAI Codex Issue #20863: configurable pet animation](https://github.com/openai/codex/issues/20863)
- [Mimi Codex Pet reference package](https://github.com/Spacebody/mimi-codex-pet)
- [codex-pet CLI and package documentation](https://codex-pet.com/docs)

## 13. Current implementation status

截至 2026-07-17：

- Pet 图集生成、chroma-key 去背景、RGBA WebP 输出、Codex V2 `1536 × 2288` / 8 × 11 / `spriteVersionNumber: 2` 校验、未使用单元格透明校验、manifest 校验、原子安装和本地状态查询已经实现；
- 配套主题 + Pet Bundle 创建、配套切换和合并状态查询已经实现；
- 英文 `SKILL.md` 已加入 Pet 和配套 Bundle 编排规则；
- 自动化回归测试为 `88/88`，Windows 路径、PowerShell 设置入口和安装契约测试为 `3/3`；Windows workflow 另会从官方安装包读取 `hatch-pet/references/codex-pet-contract.md`，通过 `verify-pet-contract.mjs` 独立确认 v2 格式，再由 `verify-pet-desktop.mjs` 要求真实 selected-row 和 loaded-sprite postcondition；
- 当前模板 contract 已更新为随 ChatGPT Desktop 提供的 Codex V2 observed contract；`--allow-provisional` 仅保留给未来契约变更的开发测试；
- 本机 ChatGPT Desktop `26.715.21316` 已发现官方 `hatch-pet` 资源契约；已通过当前 Renderer 的可见 Settings > Pets 控件真实完成 Refresh、匹配 Pet 选择、selected-row postcondition 和 embedded custom WebP sprite loaded postcondition，适配器版本为 `chatgpt-desktop-pets-settings-v1`；实测 `/pet` 返回 “isn’t a recognized command here”，因此不作为当前版本唤醒路径，Windows 仍缺少本机手工验证。

契约冻结已经解除，剩余安全门是 Windows Pet 原生选择的已登录桌面验收。工具可以生成、安装并在当前 macOS UI 中确认 v2 Pet 已选择且自定义 WebP 精灵已加载；Windows 主题注入链路已确认，但当前干净 Runner 没有可见 Settings 控件，因此只能返回真实的 `refresh-required` 降级状态。当前版本的 `/pet` 已被实测为无效命令，运行 postcondition 应使用可见 Pet 预览/Overlay、资源加载状态和动画状态，不得把无效命令响应误报为唤醒成功。
