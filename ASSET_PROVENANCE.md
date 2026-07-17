# 视觉素材来源与再分发状态

本表记录当前仓库能够证明的事实与项目所有者作出的发布决定。Git 历史能证明文件何时进入仓库，不能单独证明原始作者、生成工具、授权链或再分发许可。

`node scripts/check-asset-provenance.mjs --check` 校验清单完整性。公开发布前必须运行 `node scripts/check-asset-provenance.mjs --release`；它接受「已验证可公开再分发」或「项目所有者确认公开发布」两种状态。后者表示项目所有者在知悉来源记录边界后明确接受公开发布风险，不等同于第三方法律意见或商业授权证明。

2026-07-17，项目所有者确认当前清单中的视觉素材可以随 `v5.1.0` 公开发布。后续新增素材仍须逐项登记，未经验证或所有者确认的状态继续阻断 Release。

| 仓库路径 | 用途 | 已知创建或来源证据 | 已知许可 | 再分发状态 | 替换行动 |
| --- | --- | --- | --- | --- | --- |
| `assets/miku-character.png` | Miku 主题角色图层 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `assets/miku-full-canvas.png` | Miku 主题完整画布 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `assets/miku-hero.png` | Miku 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `assets/miku-polaroid.png` | Miku 主题拍立得装饰 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `assets/miku-portrait-reference.png` | Miku 主题肖像参考 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐可核验来源或替换 |
| `assets/miku-reference.png` | Miku 主题构图参考 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐可核验来源或替换 |
| `assets/miku-sidebar-wash.png` | Miku 主题侧栏纹理 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `assets/previews/genshin-impact-codex-ui-1.webp` | Genshin 预设预览 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐来源记录或替换预览 |
| `assets/previews/genshin-impact-codex-ui-2.webp` | Genshin 预设预览 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐来源记录或替换预览 |
| `assets/previews/love-and-deepspace-codex-ui-1.webp` | Love and Deepspace 预设预览 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐来源记录或替换预览 |
| `assets/previews/love-and-deepspace-codex-ui-2.webp` | Love and Deepspace 预设预览 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐来源记录或替换预览 |
| `assets/previews/miku-studio.webp` | Miku Studio 预览 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐来源记录或替换预览 |
| `assets/previews/naruto-codex-ui-1.webp` | Naruto 预设预览 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐来源记录或替换预览 |
| `assets/previews/naruto-codex-ui-2.webp` | Naruto 预设预览 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐来源记录或替换预览 |
| `assets/previews/wuthering-waves-codex-ui-1.webp` | Wuthering Waves 预设预览 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐来源记录或替换预览 |
| `assets/previews/wuthering-waves-codex-ui-2.webp` | Wuthering Waves 预设预览 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补齐来源记录或替换预览 |
| `custom-pet/miku-future/spritesheet.webp` | Miku 宠物精灵图 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的精灵图 |
| `docs/images/appearance-theme-contrast.jpg` | 外观主题配色设置说明截图 | 仓库标注为运行截图，但原始采集与画面权利记录缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补充自有截图与来源记录 |
| `docs/images/dalao-live.jpg` | 大佬点烟主题运行截图 | 仓库标注为运行截图，但原始采集与画面权利记录缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补充自有截图与来源记录 |
| `docs/images/genshin-dawn-live.jpg` | Genshin Dawn 运行截图 | 仓库标注为运行截图，但原始采集与画面权利记录缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补充自有截图与来源记录 |
| `docs/images/genshin-night-live.jpg` | Genshin Night 运行截图 | 仓库标注为运行截图，但原始采集与画面权利记录缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补充自有截图与来源记录 |
| `docs/images/miku-switcher-live.jpg` | Miku 菜单运行截图 | 仓库标注为运行截图，但原始采集与画面权利记录缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补充自有截图与来源记录 |
| `docs/images/wechat-group-qr.png` | 微信交流群二维码 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续由群管理员补充发布记录 |
| `docs/images/wuthering-live.jpg` | Wuthering Waves 主题运行截图 | 仓库标注为运行截图，但原始采集与画面权利记录缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补充自有截图与来源记录 |
| `themes/dalao-dianyan/hero.webp` | Dalao Dianyan 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补充人物及图像权利记录 |
| `themes/deepspace-dawn/hero.webp` | Deepspace Dawn 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `themes/deepspace-star/hero.webp` | Deepspace Star 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `themes/genshin-dawn/hero.webp` | Genshin Dawn 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `themes/genshin-night/hero.webp` | Genshin Night 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `themes/miku-488137/hero.webp` | Miku 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `themes/miku-488137/logo.webp` | Miku 主题 Logo | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续补充标识来源或替换 |
| `themes/miku-488137/polaroid.webp` | Miku 主题拍立得装饰 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `themes/naruto-hokage/hero.webp` | Naruto Hokage 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `themes/naruto-sasuke/hero.webp` | Naruto Sasuke 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `themes/wuthering-echo/hero.webp` | Wuthering Echo 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |
| `themes/wuthering-tide/hero.webp` | Wuthering Tide 主题主视觉 | 来源证据缺失，授权未验证 | 未知 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的素材 |

MIT 许可证只适用于软件代码，不自动改变第三方可能拥有的素材权利。项目所有者确认发布表示接受当前发布决定及其风险。新增、替换或删除图片后，必须运行 `node scripts/check-asset-provenance.mjs --check`，并在同一变更中同步本表。
